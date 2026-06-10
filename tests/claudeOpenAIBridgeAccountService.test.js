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
const service = require('../src/services/account/claudeOpenAIBridgeAccountService')

describe('claudeOpenAIBridgeAccountService', () => {
  beforeEach(() => {
    redis.__hashes.clear()
    redis.__sets.clear()
    redis.__values.clear()
    jest.clearAllMocks()
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
      mappingCount: 1
    })

    const raw = redis.__hashes.get(`claude_openai_bridge_account:${created.id}`)
    expect(raw.apiKey).not.toBe('secret-key')
    expect(raw.proxy).toBe(JSON.stringify({ type: 'http', host: '127.0.0.1', port: 8118 }))
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
      dailyUsage: 0
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

    await expect(service.getAllAccounts()).resolves.toEqual([])
    await expect(service.getAllAccounts(true)).resolves.toHaveLength(1)

    await expect(service.deleteAccount(account.id)).resolves.toEqual({ success: true })
    expect(redis.__hashes.has(`claude_openai_bridge_account:${account.id}`)).toBe(false)
    expect(redis.__sets.get('claude_openai_bridge_account:index').has(account.id)).toBe(false)
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

    await service.updateAccount(olderSamePriority.id, {
      createdAt: '2026-06-11T08:00:00.000Z',
      lastUsedAt: '2026-06-11T10:00:00.000Z'
    })
    await service.updateAccount(laterSamePriority.id, {
      createdAt: '2026-06-11T09:00:00.000Z',
      lastUsedAt: '2026-06-11T10:00:00.000Z'
    })
    await service.updateAccount(lowerPriority.id, {
      createdAt: '2026-06-11T07:00:00.000Z',
      lastUsedAt: '2026-06-11T09:00:00.000Z'
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
    const rawLimited = redis.__hashes.get(`claude_openai_bridge_account:${account.id}`)
    expect(limited.status).toBe('rateLimited')
    expect(limited.schedulable).toBe(false)
    expect(rawLimited.schedulable).toBe('false')
    expect(limited.rateLimitedAt).toBeTruthy()
    expect(limited.rateLimitResetAt).toBeTruthy()
    expect(limited.errorMessage).toContain('Rate limited until')

    await service.resetAccountStatus(account.id)
    const reset = await service.getAccount(account.id)
    const rawReset = redis.__hashes.get(`claude_openai_bridge_account:${account.id}`)
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
