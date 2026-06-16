jest.mock('../src/models/redis', () => {
  const hashes = new Map()
  const sets = new Map()
  const values = new Map()

  const client = {
    hset: jest.fn(async (key, value) => {
      hashes.set(key, { ...(hashes.get(key) || {}), ...value })
      return 'OK'
    }),
    hgetall: jest.fn(async (key) => hashes.get(key) || {}),
    hincrbyfloat: jest.fn(async (key, field, increment) => {
      const next = (parseFloat(hashes.get(key)?.[field] || '0') || 0) + parseFloat(increment)
      hashes.set(key, { ...(hashes.get(key) || {}), [field]: next.toString() })
      return next.toString()
    }),
    del: jest.fn(async (key) => {
      const existed = hashes.delete(key) || values.delete(key)
      return existed ? 1 : 0
    }),
    sadd: jest.fn(async (key, value) => {
      if (!sets.has(key)) {
        sets.set(key, new Set())
      }
      sets.get(key).add(value)
      return 1
    }),
    srem: jest.fn(async (key, value) => {
      sets.get(key)?.delete(value)
      return 1
    }),
    get: jest.fn(async (key) => values.get(key) || null),
    set: jest.fn(async (key, value) => {
      values.set(key, value)
      return 'OK'
    })
  }

  return {
    getClientSafe: () => client,
    addToIndex: jest.fn(async (index, id) => client.sadd(index, id)),
    removeFromIndex: jest.fn(async (index, id) => client.srem(index, id)),
    getAllIdsByIndex: jest.fn(async (index) => Array.from(sets.get(index) || [])),
    getDateStringInTimezone: jest.fn(() => '2026-06-11'),
    __client: client,
    __hashes: hashes,
    __sets: sets,
    __values: values
  }
})

jest.mock('../src/services/accountGroupService', () => ({
  getGroupMembers: jest.fn()
}))

jest.mock(
  '../config/config',
  () => ({
    security: { encryptionKey: 'test-encryption-key' }
  }),
  { virtual: true }
)

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const redis = require('../src/models/redis')
const accountGroupService = require('../src/services/accountGroupService')
const service = require('../src/services/account/claudeOpenAIBridgeAccountService')

describe('claudeOpenAIBridgeAccountService', () => {
  const rawAccountKey = (accountId) => `claude_openai_bridge_account:${accountId}`
  const setRawAccountFields = (accountId, fields) => {
    const key = rawAccountKey(accountId)
    redis.__hashes.set(key, { ...redis.__hashes.get(key), ...fields })
  }

  beforeEach(() => {
    redis.__hashes.clear()
    redis.__sets.clear()
    redis.__values.clear()
    jest.clearAllMocks()
    accountGroupService.getGroupMembers.mockResolvedValue([])
  })

  it('stores global enabled config with false default', async () => {
    await expect(service.getConfig()).resolves.toEqual({ enabled: false })

    await expect(service.updateConfig({ enabled: true })).resolves.toEqual({ enabled: true })

    expect(redis.__values.get('claude_openai_bridge:config')).toBe('{"enabled":true}')
    await expect(service.getConfig()).resolves.toEqual({ enabled: true })
  })

  it('creates accounts with defaults, encrypted api key, decrypted detail, and masked list output', async () => {
    const created = await service.createAccount({
      name: 'Azure Bridge',
      endpointUrl: 'https://bc-openai-1.openai.azure.com/openai/v1/chat/completions',
      apiKey: 'secret-key',
      accountType: 'group',
      groupId: 'group-1',
      groupIds: ['group-1', 'group-2'],
      expiresAt: '2026-07-01T00:00:00.000Z',
      modelMappings: [
        { sourceModel: ' deepseek-v4-flash ', targetModel: ' DeepSeek-V4-Flash ', enabled: true },
        { sourceModel: '', targetModel: 'Ignored', enabled: true }
      ],
      proxy: { type: 'http', host: '127.0.0.1', port: 8118 },
      dailyQuota: 12,
      priority: 10
    })

    expect(created).toMatchObject({
      apiKey: '***',
      platform: 'claude-openai-bridge',
      status: 'active',
      priority: 10,
      rateLimitDuration: 60,
      dailyQuota: 12,
      dailyUsage: 0,
      schedulable: true,
      isActive: true,
      mappingCount: 1,
      accountType: 'group',
      groupId: 'group-1',
      groupIds: ['group-1', 'group-2'],
      expiresAt: '2026-07-01T00:00:00.000Z'
    })

    const raw = redis.__hashes.get(`claude_openai_bridge_account:${created.id}`)
    expect(raw.apiKey).not.toBe('secret-key')
    expect(raw.proxy).toBe(JSON.stringify({ type: 'http', host: '127.0.0.1', port: 8118 }))
    expect(raw.accountType).toBe('group')
    expect(raw.groupId).toBe('group-1')
    expect(raw.groupIds).toBe(JSON.stringify(['group-1', 'group-2']))
    expect(raw.expiresAt).toBe('2026-07-01T00:00:00.000Z')
    expect(raw.modelMappings).toBe(
      JSON.stringify([
        { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash', enabled: true }
      ])
    )
    expect(redis.__sets.get('claude_openai_bridge_account:index').has(created.id)).toBe(true)

    const full = await service.getAccount(created.id)
    expect(full).toMatchObject({
      apiKey: 'secret-key',
      proxy: { type: 'http', host: '127.0.0.1', port: 8118 },
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash', enabled: true }
      ],
      platform: 'claude-openai-bridge',
      priority: 10,
      dailyQuota: 12,
      dailyUsage: 0,
      accountType: 'group',
      groupId: 'group-1',
      groupIds: ['group-1', 'group-2'],
      expiresAt: '2026-07-01T00:00:00.000Z'
    })

    const all = await service.getAllAccounts(true)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({
      apiKey: '***',
      mappingCount: 1,
      proxy: { type: 'http', host: '127.0.0.1', port: 8118 }
    })
  })

  it('updates accounts, filters inactive list results, and deletes hashes plus indexes', async () => {
    const account = await service.createAccount({
      endpointUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'old-key',
      modelMappings: [{ sourceModel: 'old-model', targetModel: 'OldModel', enabled: true }]
    })

    await service.updateAccount(account.id, {
      apiKey: 'new-key',
      proxy: null,
      modelMappings: [{ sourceModel: 'new-model', targetModel: 'NewModel', enabled: 'false' }],
      isActive: false,
      schedulable: 'false',
      priority: '5',
      dailyQuota: '42',
      dailyUsage: '7'
    })

    const raw = redis.__hashes.get(`claude_openai_bridge_account:${account.id}`)
    expect(raw.apiKey).not.toBe('new-key')
    expect(raw.proxy).toBe('')
    expect(raw.isActive).toBe('false')
    expect(raw.schedulable).toBe('false')
    expect(raw.priority).toBe('5')
    expect(raw.updatedAt).toBeTruthy()

    const detail = await service.getAccount(account.id)
    expect(detail).toMatchObject({
      apiKey: 'new-key',
      proxy: null,
      isActive: false,
      schedulable: false,
      priority: 5,
      dailyQuota: 42,
      dailyUsage: 7,
      modelMappings: [{ sourceModel: 'new-model', targetModel: 'NewModel', enabled: false }]
    })

    await service.updateAccount(account.id, {
      accountType: 'dedicated',
      groupId: '',
      groupIds: [],
      expiresAt: '2026-08-01T00:00:00.000Z'
    })

    expect(await service.getAccount(account.id)).toMatchObject({
      accountType: 'dedicated',
      groupId: '',
      groupIds: [],
      expiresAt: '2026-08-01T00:00:00.000Z'
    })

    await expect(service.getAllAccounts()).resolves.toEqual([])
    await expect(service.getAllAccounts(true)).resolves.toHaveLength(1)

    await expect(service.deleteAccount(account.id)).resolves.toEqual({ success: true })
    expect(redis.__hashes.has(rawAccountKey(account.id))).toBe(false)
    expect(redis.__sets.get('claude_openai_bridge_account:index').has(account.id)).toBe(false)
  })

  it('ignores immutable fields and masked api key updates', async () => {
    const account = await service.createAccount({
      endpointUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'original-key'
    })
    const originalRaw = redis.__hashes.get(rawAccountKey(account.id))

    await service.updateAccount(account.id, {
      id: 'corrupted-id',
      platform: 'other-platform',
      createdAt: '2000-01-01T00:00:00.000Z',
      apiKey: '***',
      name: 'Renamed'
    })

    const afterMasked = redis.__hashes.get(rawAccountKey(account.id))
    expect(afterMasked).toMatchObject({
      id: account.id,
      platform: 'claude-openai-bridge',
      createdAt: originalRaw.createdAt,
      apiKey: originalRaw.apiKey,
      name: 'Renamed'
    })

    await service.updateAccount(account.id, { apiKey: '' })
    expect(redis.__hashes.get(rawAccountKey(account.id)).apiKey).toBe(originalRaw.apiKey)

    await service.updateAccount(account.id, { apiKey: undefined })
    expect(redis.__hashes.get(rawAccountKey(account.id)).apiKey).toBe(originalRaw.apiKey)

    await service.updateAccount(account.id, { apiKey: 'updated-key' })
    expect(await service.getAccount(account.id)).toMatchObject({
      id: account.id,
      apiKey: 'updated-key',
      platform: 'claude-openai-bridge'
    })
  })

  it('rejects blank endpoint URL updates and preserves the previous endpoint', async () => {
    const account = await service.createAccount({
      endpointUrl: 'https://valid.example.com/v1/chat/completions',
      apiKey: 'key'
    })

    await expect(service.updateAccount(account.id, { endpointUrl: '   ' })).rejects.toThrow(
      'Endpoint URL cannot be empty'
    )

    expect(await service.getAccount(account.id)).toMatchObject({
      endpointUrl: 'https://valid.example.com/v1/chat/completions'
    })
  })

  it('selects an eligible account by exact source model, priority, lastUsedAt, and createdAt', async () => {
    await service.updateConfig({ enabled: true })
    const olderSamePriority = await service.createAccount({
      name: 'Older Same Priority',
      endpointUrl: 'https://example.net/v1/chat/completions',
      apiKey: 'key-c',
      priority: 5,
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash-C', enabled: true }
      ]
    })
    const laterSamePriority = await service.createAccount({
      name: 'Later Same Priority',
      endpointUrl: 'https://example.org/v1/chat/completions',
      apiKey: 'key-b',
      priority: 5,
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash-B', enabled: true }
      ]
    })
    const lowerPriority = await service.createAccount({
      name: 'Priority 20',
      endpointUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'key-a',
      priority: 20,
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash-A', enabled: true },
        { sourceModel: 'disabled-model', targetModel: 'Disabled', enabled: false }
      ]
    })

    setRawAccountFields(olderSamePriority.id, {
      createdAt: '2026-06-11T08:00:00.000Z',
      lastUsedAt: '2026-06-11T11:00:00.000Z'
    })
    setRawAccountFields(laterSamePriority.id, {
      createdAt: '2026-06-11T09:00:00.000Z',
      lastUsedAt: '2026-06-11T10:00:00.000Z'
    })
    setRawAccountFields(lowerPriority.id, {
      createdAt: '2026-06-11T07:00:00.000Z',
      lastUsedAt: '2026-06-11T09:00:00.000Z'
    })

    const olderLastUsedSelection = await service.selectAccountForModel('deepseek-v4-flash')

    expect(olderLastUsedSelection.account.id).toBe(laterSamePriority.id)
    expect(olderLastUsedSelection.mapping.targetModel).toBe('DeepSeek-V4-Flash-B')

    setRawAccountFields(olderSamePriority.id, {
      lastUsedAt: '2026-06-11T10:00:00.000Z'
    })
    setRawAccountFields(laterSamePriority.id, {
      lastUsedAt: '2026-06-11T10:00:00.000Z'
    })

    const selection = await service.selectAccountForModel('deepseek-v4-flash')

    expect(selection.account.id).toBe(olderSamePriority.id)
    expect(selection.account.apiKey).toBe('key-c')
    expect(selection.mapping).toEqual({
      sourceModel: 'deepseek-v4-flash',
      targetModel: 'DeepSeek-V4-Flash-C',
      enabled: true
    })

    await expect(service.selectAccountForModel('DeepSeek-V4-Flash')).resolves.toBe(null)
    await expect(service.selectAccountForModel('disabled-model')).resolves.toBe(null)

    await service.updateAccount(olderSamePriority.id, { schedulable: false })
    const fallback = await service.selectAccountForModel('deepseek-v4-flash')
    expect(fallback.account.id).toBe(laterSamePriority.id)

    await service.updateConfig({ enabled: false })
    await expect(service.selectAccountForModel('deepseek-v4-flash')).resolves.toBe(null)
  })

  it('keeps dedicated accounts out of the shared pool but honors direct and group bindings', async () => {
    await service.updateConfig({ enabled: true })
    const dedicated = await service.createAccount({
      name: 'Dedicated',
      endpointUrl: 'https://dedicated.example.com/v1/chat/completions',
      apiKey: 'dedicated-key',
      accountType: 'dedicated',
      priority: 1,
      modelMappings: [
        { sourceModel: 'deepseek-v4-pro', targetModel: 'DeepSeek-V4-Pro-Dedicated', enabled: true }
      ]
    })
    await service.createAccount({
      name: 'Shared',
      endpointUrl: 'https://shared.example.com/v1/chat/completions',
      apiKey: 'shared-key',
      accountType: 'shared',
      priority: 50,
      modelMappings: [
        { sourceModel: 'deepseek-v4-pro', targetModel: 'DeepSeek-V4-Pro-Shared', enabled: true }
      ]
    })

    const sharedPoolSelection = await service.selectAccountForModel('deepseek-v4-pro')
    expect(sharedPoolSelection.account.id).not.toBe(dedicated.id)
    expect(sharedPoolSelection.mapping.targetModel).toBe('DeepSeek-V4-Pro-Shared')

    const directBindingSelection = await service.selectAccountForModel('deepseek-v4-pro', {
      boundAccountId: dedicated.id
    })
    expect(directBindingSelection.account.id).toBe(dedicated.id)
    expect(directBindingSelection.mapping.targetModel).toBe('DeepSeek-V4-Pro-Dedicated')

    accountGroupService.getGroupMembers.mockResolvedValue([dedicated.id])
    const groupBindingSelection = await service.selectAccountForModel('deepseek-v4-pro', {
      boundAccountId: 'group:bridge-group-1'
    })
    expect(groupBindingSelection.account.id).toBe(dedicated.id)
    expect(accountGroupService.getGroupMembers).toHaveBeenCalledWith('bridge-group-1')
  })

  it('does not select accounts that are daily quota exhausted or quota stopped', async () => {
    await service.updateConfig({ enabled: true })
    const quotaExhausted = await service.createAccount({
      name: 'Quota Exhausted',
      endpointUrl: 'https://quota.example.com/v1/chat/completions',
      apiKey: 'quota-key',
      priority: 1,
      dailyQuota: 10,
      dailyUsage: 10,
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'QuotaTarget', enabled: true }
      ]
    })
    const quotaStopped = await service.createAccount({
      name: 'Quota Stopped',
      endpointUrl: 'https://stopped.example.com/v1/chat/completions',
      apiKey: 'stopped-key',
      priority: 2,
      dailyQuota: 0,
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'StoppedTarget', enabled: true }
      ]
    })
    const eligible = await service.createAccount({
      name: 'Eligible',
      endpointUrl: 'https://eligible.example.com/v1/chat/completions',
      apiKey: 'eligible-key',
      priority: 50,
      dailyQuota: 10,
      dailyUsage: 9,
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'EligibleTarget', enabled: true }
      ]
    })

    await service.updateAccount(quotaStopped.id, { quotaStoppedAt: '2026-06-11T12:00:00.000Z' })

    const selection = await service.selectAccountForModel('deepseek-v4-flash')
    expect(selection.account.id).toBe(eligible.id)
    expect(selection.mapping.targetModel).toBe('EligibleTarget')

    await service.updateAccount(eligible.id, { dailyUsage: 10 })

    await expect(service.selectAccountForModel('deepseek-v4-flash')).resolves.toBe(null)
    expect((await service.getAccount(quotaExhausted.id)).dailyUsage).toBe(10)
  })

  it('recovers expired rate-limited accounts during model selection', async () => {
    await service.updateConfig({ enabled: true })
    const account = await service.createAccount({
      endpointUrl: 'https://recover.example.com/v1/chat/completions',
      apiKey: 'recover-key',
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'RecoveredTarget', enabled: true }
      ]
    })

    setRawAccountFields(account.id, {
      status: 'rateLimited',
      schedulable: 'false',
      rateLimitedAt: '2026-06-11T00:00:00.000Z',
      rateLimitResetAt: '2000-01-01T00:00:00.000Z',
      errorMessage: 'Rate limited until 2000-01-01T00:00:00.000Z'
    })

    const selection = await service.selectAccountForModel('deepseek-v4-flash')

    expect(selection.account.id).toBe(account.id)
    expect(selection.mapping.targetModel).toBe('RecoveredTarget')
    expect(await service.getAccount(account.id)).toMatchObject({
      status: 'active',
      schedulable: true,
      rateLimitedAt: '',
      rateLimitResetAt: '',
      errorMessage: ''
    })
  })

  it('resets stale quota-stop windows before selecting bridge accounts', async () => {
    await service.updateConfig({ enabled: true })
    const account = await service.createAccount({
      endpointUrl: 'https://quota-recover.example.com/v1/chat/completions',
      apiKey: 'quota-recover-key',
      dailyQuota: 10,
      dailyUsage: 10,
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'QuotaRecoveredTarget', enabled: true }
      ]
    })

    setRawAccountFields(account.id, {
      dailyUsage: '10',
      lastResetDate: '2026-06-10',
      quotaStoppedAt: '2026-06-10T23:59:00.000Z',
      status: 'quotaExceeded',
      schedulable: 'false',
      errorMessage: 'Daily quota exceeded'
    })

    const selection = await service.selectAccountForModel('deepseek-v4-flash')

    expect(selection.account.id).toBe(account.id)
    expect(selection.mapping.targetModel).toBe('QuotaRecoveredTarget')
    expect(await service.getAccount(account.id)).toMatchObject({
      dailyUsage: 0,
      lastResetDate: '2026-06-11',
      quotaStoppedAt: '',
      status: 'active',
      schedulable: true,
      errorMessage: ''
    })
  })

  it('updates lastUsedAt and status/quota helper fields', async () => {
    const account = await service.createAccount({
      name: 'Protected',
      endpointUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'key',
      disableAutoProtection: false,
      dailyUsage: 9,
      modelMappings: [{ sourceModel: 'kimi-k2.6', targetModel: 'Kimi-K2.6', enabled: true }]
    })

    await service.markAccountUsed(account.id)
    expect((await service.getAccount(account.id)).lastUsedAt).toBeTruthy()

    await service.markAccountRateLimited(account.id, 30)
    const limited = await service.getAccount(account.id)
    const rawLimited = redis.__hashes.get(rawAccountKey(account.id))
    expect(limited.status).toBe('rateLimited')
    expect(limited.schedulable).toBe(false)
    expect(rawLimited.schedulable).toBe('false')
    expect(limited.rateLimitedAt).toBeTruthy()
    expect(limited.rateLimitResetAt).toBeTruthy()
    expect(limited.errorMessage).toContain('Rate limited until')

    await service.resetAccountStatus(account.id)
    const reset = await service.getAccount(account.id)
    const rawReset = redis.__hashes.get(rawAccountKey(account.id))
    expect(reset.status).toBe('active')
    expect(reset.schedulable).toBe(true)
    expect(rawReset.schedulable).toBe('true')
    expect(reset.errorMessage).toBe('')
    expect(reset.rateLimitedAt).toBe('')
    expect(reset.rateLimitResetAt).toBe('')

    await service.markAccountUnauthorized(account.id, 'bad key')
    expect(await service.getAccount(account.id)).toMatchObject({
      status: 'unauthorized',
      schedulable: false,
      errorMessage: 'bad key'
    })

    await service.markAccountError(account.id, 'upstream failed')
    expect(await service.getAccount(account.id)).toMatchObject({
      status: 'error',
      schedulable: false,
      errorMessage: 'upstream failed'
    })

    await service.resetUsage(account.id)
    expect(await service.getAccount(account.id)).toMatchObject({
      dailyUsage: 0,
      lastResetDate: '2026-06-11'
    })
  })

  it('records daily usage, resets stale daily windows, and stops quota-exhausted accounts', async () => {
    const account = await service.createAccount({
      endpointUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'key',
      dailyQuota: 10,
      dailyUsage: 3
    })

    await expect(service.recordUsage(account.id, 4)).resolves.toMatchObject({
      success: true,
      dailyUsage: 7,
      quotaExceeded: false
    })
    expect(await service.getAccount(account.id)).toMatchObject({
      dailyUsage: 7,
      status: 'active',
      schedulable: true,
      quotaStoppedAt: ''
    })

    await expect(service.recordUsage(account.id, 3)).resolves.toMatchObject({
      success: true,
      dailyUsage: 10,
      quotaExceeded: true
    })
    expect(await service.getAccount(account.id)).toMatchObject({
      dailyUsage: 10,
      status: 'quotaExceeded',
      schedulable: false,
      errorMessage: 'Daily quota exceeded'
    })
    expect((await service.getAccount(account.id)).quotaStoppedAt).toBeTruthy()

    setRawAccountFields(account.id, {
      dailyUsage: '8',
      lastResetDate: '2026-06-10',
      quotaStoppedAt: '2026-06-10T23:59:00.000Z',
      status: 'quotaExceeded',
      schedulable: 'false',
      errorMessage: 'Daily quota exceeded'
    })

    await expect(service.recordUsage(account.id, 1)).resolves.toMatchObject({
      success: true,
      dailyUsage: 1,
      quotaExceeded: false
    })
    expect(await service.getAccount(account.id)).toMatchObject({
      dailyUsage: 1,
      lastResetDate: '2026-06-11',
      quotaStoppedAt: '',
      status: 'active',
      schedulable: true,
      errorMessage: ''
    })
  })

  it('resetUsage clears quota stop state and makes quota-exhausted accounts selectable', async () => {
    await service.updateConfig({ enabled: true })
    const account = await service.createAccount({
      endpointUrl: 'https://quota-reset.example.com/v1/chat/completions',
      apiKey: 'quota-reset-key',
      dailyQuota: 10,
      dailyUsage: 10,
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'QuotaResetTarget', enabled: true }
      ]
    })
    setRawAccountFields(account.id, {
      status: 'quotaExceeded',
      schedulable: 'false',
      quotaStoppedAt: '2026-06-11T10:00:00.000Z',
      errorMessage: 'Daily quota exceeded'
    })

    await expect(service.selectAccountForModel('deepseek-v4-flash')).resolves.toBe(null)

    await service.resetUsage(account.id)

    expect(await service.getAccount(account.id)).toMatchObject({
      dailyUsage: 0,
      lastResetDate: '2026-06-11',
      quotaStoppedAt: '',
      status: 'active',
      schedulable: true,
      errorMessage: ''
    })
    const selection = await service.selectAccountForModel('deepseek-v4-flash')
    expect(selection.account.id).toBe(account.id)
  })

  it('records repeated same-day usage through Redis increments and applies quota status', async () => {
    const account = await service.createAccount({
      endpointUrl: 'https://usage.example.com/v1/chat/completions',
      apiKey: 'usage-key',
      dailyQuota: 5,
      dailyUsage: 0
    })

    await expect(service.recordUsage(account.id, 2)).resolves.toMatchObject({
      success: true,
      dailyUsage: 2,
      quotaExceeded: false
    })
    await expect(service.recordUsage(account.id, 2.5)).resolves.toMatchObject({
      success: true,
      dailyUsage: 4.5,
      quotaExceeded: false
    })
    await expect(service.recordUsage(account.id, 0.5)).resolves.toMatchObject({
      success: true,
      dailyUsage: 5,
      quotaExceeded: true
    })

    expect(redis.__client.hincrbyfloat).toHaveBeenCalledTimes(3)
    expect(await service.getAccount(account.id)).toMatchObject({
      dailyUsage: 5,
      status: 'quotaExceeded',
      schedulable: false,
      errorMessage: 'Daily quota exceeded'
    })
    expect((await service.getAccount(account.id)).quotaStoppedAt).toBeTruthy()
  })

  it('clamps negative usage amounts to zero', async () => {
    const account = await service.createAccount({
      endpointUrl: 'https://usage.example.com/v1/chat/completions',
      apiKey: 'usage-key',
      dailyQuota: 5,
      dailyUsage: 3
    })

    await expect(service.recordUsage(account.id, -2)).resolves.toMatchObject({
      success: true,
      dailyUsage: 3,
      quotaExceeded: false
    })

    expect(redis.__client.hincrbyfloat).toHaveBeenCalledWith(
      rawAccountKey(account.id),
      'dailyUsage',
      0
    )
    expect(await service.getAccount(account.id)).toMatchObject({
      dailyUsage: 3,
      status: 'active',
      schedulable: true
    })
  })

  it('skips rate-limit marking when explicit or stored duration is zero', async () => {
    const explicitZero = await service.createAccount({
      endpointUrl: 'https://explicit-zero.example.com/v1/chat/completions',
      apiKey: 'explicit-key'
    })
    const storedZero = await service.createAccount({
      endpointUrl: 'https://stored-zero.example.com/v1/chat/completions',
      apiKey: 'stored-key',
      rateLimitDuration: 0
    })

    await expect(service.markAccountRateLimited(explicitZero.id, 0)).resolves.toMatchObject({
      success: true,
      skipped: true
    })
    expect(await service.getAccount(explicitZero.id)).toMatchObject({
      status: 'active',
      schedulable: true,
      rateLimitedAt: '',
      rateLimitResetAt: ''
    })

    await expect(service.markAccountRateLimited(storedZero.id)).resolves.toMatchObject({
      success: true,
      skipped: true
    })
    expect(await service.getAccount(storedZero.id)).toMatchObject({
      status: 'active',
      schedulable: true,
      rateLimitDuration: 0,
      rateLimitedAt: '',
      rateLimitResetAt: ''
    })
  })

  it('does not auto-disable rate limited accounts when auto protection is off', async () => {
    const account = await service.createAccount({
      endpointUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'key',
      disableAutoProtection: true
    })

    await service.markAccountRateLimited(account.id, 30)

    expect(await service.getAccount(account.id)).toMatchObject({
      status: 'active',
      schedulable: true,
      errorMessage: ''
    })
  })

  it('normalizes model mappings from arrays and serialized values', () => {
    expect(
      service._normalizeMappings(
        JSON.stringify([
          { sourceModel: ' source ', targetModel: ' Target ', enabled: 'false' },
          { sourceModel: 'missing-target', enabled: true },
          null
        ])
      )
    ).toEqual([{ sourceModel: 'source', targetModel: 'Target', enabled: false }])

    expect(service._normalizeMappings('not json')).toEqual([])
    expect(service._normalizeMappings({ sourceModel: 'x' })).toEqual([])
  })
})
