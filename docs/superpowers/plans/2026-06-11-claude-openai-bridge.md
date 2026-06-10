# Claude OpenAI Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an admin-configurable Claude Messages to OpenAI-compatible chat completions bridge for selected model names.

**Architecture:** Add a dedicated bridge account/config service backed by Redis, a standalone Claude/OpenAI conversion service, and a relay service that posts converted requests to each account's full `endpointUrl`. `/api/v1/messages` checks the global switch and exact model mappings before normal Claude scheduling; admin APIs and the accounts SPA expose the new bridge accounts and mappings.

**Tech Stack:** Node.js, Express, Redis, Axios, Jest/SuperTest, Vue 3, Pinia, Vite.

---

## File Structure

- Create `src/services/account/claudeOpenAIBridgeAccountService.js`: stores global bridge config and bridge accounts in Redis, encrypts API keys, selects eligible accounts by mapping, priority, and last-used time, tracks quota/status.
- Create `src/services/claudeOpenAIBridgeConverter.js`: pure conversion helpers for Claude Messages request/response/SSE shapes and OpenAI chat completions shapes.
- Create `src/services/relay/claudeOpenAIBridgeRelayService.js`: network relay, proxy handling, upstream error handling, usage recording, rate-limit counter updates, and handoff logs.
- Create `src/routes/admin/claudeOpenAIBridgeAccounts.js`: admin CRUD/config/test routes.
- Modify `src/routes/admin/index.js`: mount the new admin routes.
- Modify `src/routes/api.js`: check the bridge after existing validation and forced Gemini branch, before normal Claude scheduling.
- Modify `web/admin-spa/src/utils/http_apis.js`: add bridge account/config API helpers.
- Modify `web/admin-spa/src/stores/accounts.js`: add bridge account state, fetch/create/update/delete/toggle integration.
- Modify `web/admin-spa/src/views/AccountsView.vue`: include the new platform in filters, lists, row display, reset/toggle/test endpoints, and global enable switch placement.
- Modify `web/admin-spa/src/components/accounts/AccountForm.vue`: add bridge platform option and bridge-specific endpoint/API key/quota/proxy/model-mapping form fields.
- Add backend tests:
  - `tests/claudeOpenAIBridgeAccountService.test.js`
  - `tests/claudeOpenAIBridgeConverter.test.js`
  - `tests/claudeOpenAIBridgeRelayService.test.js`
  - `tests/api.claudeOpenAIBridgeRouting.test.js`
  - `tests/admin.claudeOpenAIBridgeAccounts.test.js`

## Task 1: Account Service And Config Storage

**Files:**
- Create: `tests/claudeOpenAIBridgeAccountService.test.js`
- Create: `src/services/account/claudeOpenAIBridgeAccountService.js`

- [ ] **Step 1: Write the failing account service tests**

```javascript
jest.mock('../src/models/redis', () => {
  const hashes = new Map()
  const sets = new Map()
  const values = new Map()
  const client = {
    hset: jest.fn(async (key, value) => {
      hashes.set(key, { ...(hashes.get(key) || {}), ...value })
    }),
    hgetall: jest.fn(async (key) => hashes.get(key) || {}),
    del: jest.fn(async (key) => {
      hashes.delete(key)
      values.delete(key)
      return 1
    }),
    sadd: jest.fn(async (key, value) => {
      if (!sets.has(key)) sets.set(key, new Set())
      sets.get(key).add(value)
    }),
    srem: jest.fn(async (key, value) => {
      sets.get(key)?.delete(value)
    }),
    get: jest.fn(async (key) => values.get(key) || null),
    set: jest.fn(async (key, value) => {
      values.set(key, value)
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

jest.mock('../config/config', () => ({
  security: { encryptionKey: 'test-encryption-key' }
}))

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

    await service.updateConfig({ enabled: true })

    await expect(service.getConfig()).resolves.toEqual({ enabled: true })
  })

  it('creates accounts with encrypted api key and masked list output', async () => {
    const created = await service.createAccount({
      name: 'Azure Bridge',
      endpointUrl: 'https://bc-openai-1.openai.azure.com/openai/v1/chat/completions',
      apiKey: 'secret-key',
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash', enabled: true }
      ],
      proxy: { type: 'http', host: '127.0.0.1', port: 8118 },
      dailyQuota: 12,
      priority: 10
    })

    expect(created.apiKey).toBe('***')

    const raw = redis.__hashes.get(`claude_openai_bridge_account:${created.id}`)
    expect(raw.apiKey).not.toBe('secret-key')
    expect(raw.modelMappings).toContain('deepseek-v4-flash')

    const full = await service.getAccount(created.id)
    expect(full.apiKey).toBe('secret-key')
    expect(full.proxy).toEqual({ type: 'http', host: '127.0.0.1', port: 8118 })
    expect(full.modelMappings).toEqual([
      { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash', enabled: true }
    ])

    const all = await service.getAllAccounts(true)
    expect(all[0].apiKey).toBe('***')
    expect(all[0].mappingCount).toBe(1)
  })

  it('selects an eligible account by exact source model, priority, lastUsedAt, and enabled switch', async () => {
    await service.updateConfig({ enabled: true })
    const first = await service.createAccount({
      name: 'Priority 20',
      endpointUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'key-a',
      priority: 20,
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash', enabled: true }
      ]
    })
    const second = await service.createAccount({
      name: 'Priority 5',
      endpointUrl: 'https://example.org/v1/chat/completions',
      apiKey: 'key-b',
      priority: 5,
      modelMappings: [
        { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash', enabled: true }
      ]
    })

    await service.updateAccount(first.id, { lastUsedAt: '2026-06-11T10:00:00.000Z' })
    await service.updateAccount(second.id, { lastUsedAt: '2026-06-11T11:00:00.000Z' })

    const selection = await service.selectAccountForModel('deepseek-v4-flash')

    expect(selection.account.id).toBe(second.id)
    expect(selection.mapping.targetModel).toBe('DeepSeek-V4-Flash')

    await service.updateConfig({ enabled: false })
    await expect(service.selectAccountForModel('deepseek-v4-flash')).resolves.toBe(null)
  })

  it('marks rate limit and resets status without disabling accounts when auto protection is off', async () => {
    const account = await service.createAccount({
      name: 'Protected',
      endpointUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'key',
      disableAutoProtection: false,
      modelMappings: [
        { sourceModel: 'kimi-k2.6', targetModel: 'Kimi-K2.6', enabled: true }
      ]
    })

    await service.markAccountRateLimited(account.id, 30)
    const limited = await service.getAccount(account.id)
    expect(limited.status).toBe('rateLimited')
    expect(limited.schedulable).toBe('false')

    await service.resetAccountStatus(account.id)
    const reset = await service.getAccount(account.id)
    expect(reset.status).toBe('active')
    expect(reset.schedulable).toBe('true')
  })
})
```

- [ ] **Step 2: Run the account service tests to verify RED**

Run: `npm test -- tests/claudeOpenAIBridgeAccountService.test.js`

Expected: FAIL with `Cannot find module '../src/services/account/claudeOpenAIBridgeAccountService'`.

- [ ] **Step 3: Implement the account service**

Create `src/services/account/claudeOpenAIBridgeAccountService.js` with these exports:

```javascript
const { v4: uuidv4 } = require('uuid')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const { createEncryptor, sortAccountsByPriority } = require('../../utils/commonHelper')

const encryptor = createEncryptor('claude-openai-bridge-salt')
const ACCOUNT_KEY_PREFIX = 'claude_openai_bridge_account:'
const ACCOUNT_INDEX_KEY = 'claude_openai_bridge_account:index'
const CONFIG_KEY = 'claude_openai_bridge:config'

function normalizeBoolean(value, defaultValue = false) {
  if (value === undefined || value === null || value === '') return defaultValue
  return value === true || value === 'true'
}

function normalizeNumber(value, defaultValue = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : defaultValue
}

function normalizeMappings(modelMappings = []) {
  if (typeof modelMappings === 'string') {
    try {
      modelMappings = JSON.parse(modelMappings)
    } catch {
      modelMappings = []
    }
  }
  if (!Array.isArray(modelMappings)) return []
  return modelMappings
    .map((mapping) => ({
      sourceModel: String(mapping?.sourceModel || '').trim(),
      targetModel: String(mapping?.targetModel || '').trim(),
      enabled: normalizeBoolean(mapping?.enabled, true)
    }))
    .filter((mapping) => mapping.sourceModel && mapping.targetModel)
}

function serializeProxy(proxy) {
  return proxy ? JSON.stringify(proxy) : ''
}

function parseProxy(proxy) {
  if (!proxy) return null
  if (typeof proxy === 'object') return proxy
  try {
    return JSON.parse(proxy)
  } catch {
    return null
  }
}

function formatAccount(accountData, { includeSecret = false } = {}) {
  const mappings = normalizeMappings(accountData.modelMappings)
  return {
    ...accountData,
    apiKey: includeSecret ? encryptor.decrypt(accountData.apiKey || '') : accountData.apiKey ? '***' : '',
    proxy: parseProxy(accountData.proxy),
    modelMappings: mappings,
    mappingCount: mappings.filter((mapping) => mapping.enabled).length,
    isActive: normalizeBoolean(accountData.isActive, true),
    passThrough: false,
    dailyQuota: normalizeNumber(accountData.dailyQuota, 0),
    dailyUsage: normalizeNumber(accountData.dailyUsage, 0),
    priority: normalizeNumber(accountData.priority, 50),
    platform: 'claude-openai-bridge'
  }
}

async function getConfig() {
  const client = redis.getClientSafe()
  const raw = await client.get(CONFIG_KEY)
  if (!raw) return { enabled: false }
  try {
    const parsed = JSON.parse(raw)
    return { enabled: normalizeBoolean(parsed.enabled, false) }
  } catch {
    return { enabled: false }
  }
}

async function updateConfig(updates = {}) {
  const next = { enabled: normalizeBoolean(updates.enabled, false) }
  await redis.getClientSafe().set(CONFIG_KEY, JSON.stringify(next))
  logger.info('Updated Claude OpenAI bridge config', next)
  return next
}

async function createAccount(options = {}) {
  if (!options.endpointUrl || !options.apiKey) {
    throw new Error('Endpoint URL and API Key are required')
  }
  const now = new Date().toISOString()
  const id = uuidv4()
  const account = {
    id,
    platform: 'claude-openai-bridge',
    name: options.name || 'Claude OpenAI Bridge',
    description: options.description || '',
    endpointUrl: String(options.endpointUrl).trim(),
    apiKey: encryptor.encrypt(String(options.apiKey)),
    proxy: serializeProxy(options.proxy),
    isActive: normalizeBoolean(options.isActive, true).toString(),
    schedulable: normalizeBoolean(options.schedulable, true).toString(),
    status: options.status || 'active',
    errorMessage: options.errorMessage || '',
    priority: String(normalizeNumber(options.priority, 50)),
    rateLimitDuration: String(normalizeNumber(options.rateLimitDuration, 60)),
    rateLimitedAt: '',
    rateLimitResetAt: '',
    dailyQuota: String(normalizeNumber(options.dailyQuota, 0)),
    dailyUsage: String(normalizeNumber(options.dailyUsage, 0)),
    lastResetDate: redis.getDateStringInTimezone(),
    quotaResetTime: options.quotaResetTime || '00:00',
    quotaStoppedAt: '',
    disableAutoProtection: normalizeBoolean(options.disableAutoProtection, false).toString(),
    modelMappings: JSON.stringify(normalizeMappings(options.modelMappings)),
    createdAt: now,
    updatedAt: now,
    lastUsedAt: ''
  }
  const client = redis.getClientSafe()
  await client.hset(`${ACCOUNT_KEY_PREFIX}${id}`, account)
  await redis.addToIndex(ACCOUNT_INDEX_KEY, id)
  logger.success(`Created Claude OpenAI bridge account: ${account.name} (${id})`)
  return formatAccount(account)
}

async function getAccount(id) {
  const data = await redis.getClientSafe().hgetall(`${ACCOUNT_KEY_PREFIX}${id}`)
  if (!data || !data.id) return null
  return formatAccount(data, { includeSecret: true })
}

async function getAllAccounts(includeInactive = false) {
  const ids = await redis.getAllIdsByIndex(ACCOUNT_INDEX_KEY, `${ACCOUNT_KEY_PREFIX}*`, /^claude_openai_bridge_account:(.+)$/)
  const accounts = []
  for (const id of ids) {
    const data = await redis.getClientSafe().hgetall(`${ACCOUNT_KEY_PREFIX}${id}`)
    if (!data || !data.id) continue
    const account = formatAccount(data)
    if (!includeInactive && !account.isActive) continue
    accounts.push(account)
  }
  return accounts
}

async function updateAccount(id, updates = {}) {
  const existing = await getAccount(id)
  if (!existing) throw new Error('Account not found')
  const normalized = { ...updates, updatedAt: new Date().toISOString() }
  if (normalized.apiKey) normalized.apiKey = encryptor.encrypt(String(normalized.apiKey))
  if (normalized.proxy !== undefined) normalized.proxy = serializeProxy(normalized.proxy)
  if (normalized.modelMappings !== undefined) {
    normalized.modelMappings = JSON.stringify(normalizeMappings(normalized.modelMappings))
  }
  for (const key of ['isActive', 'schedulable', 'disableAutoProtection']) {
    if (normalized[key] !== undefined) normalized[key] = normalizeBoolean(normalized[key], false).toString()
  }
  for (const key of ['priority', 'rateLimitDuration', 'dailyQuota', 'dailyUsage']) {
    if (normalized[key] !== undefined) normalized[key] = String(normalizeNumber(normalized[key], key === 'priority' ? 50 : 0))
  }
  await redis.getClientSafe().hset(`${ACCOUNT_KEY_PREFIX}${id}`, normalized)
  return { success: true }
}

async function deleteAccount(id) {
  await redis.getClientSafe().del(`${ACCOUNT_KEY_PREFIX}${id}`)
  await redis.removeFromIndex(ACCOUNT_INDEX_KEY, id)
  return { success: true }
}

async function selectAccountForModel(sourceModel) {
  const config = await getConfig()
  if (!config.enabled) return null
  const accounts = await getAllAccounts(true)
  const eligible = accounts
    .filter((account) => account.isActive && account.schedulable !== false && account.status === 'active')
    .map((account) => {
      const mapping = account.modelMappings.find(
        (item) => item.enabled && item.sourceModel === sourceModel
      )
      return mapping ? { ...account, matchedMapping: mapping } : null
    })
    .filter(Boolean)
  if (eligible.length === 0) return null
  const [selected] = sortAccountsByPriority(eligible)
  const full = await getAccount(selected.id)
  return { account: full, mapping: selected.matchedMapping }
}

async function markAccountUsed(id) {
  await updateAccount(id, { lastUsedAt: new Date().toISOString() })
}

async function markAccountRateLimited(id, durationMinutes = null) {
  const account = await getAccount(id)
  if (!account) return
  if (account.disableAutoProtection === true || account.disableAutoProtection === 'true') return
  const duration = durationMinutes || normalizeNumber(account.rateLimitDuration, 60)
  const resetAt = new Date(Date.now() + duration * 60000).toISOString()
  await updateAccount(id, {
    status: 'rateLimited',
    schedulable: false,
    rateLimitedAt: new Date().toISOString(),
    rateLimitResetAt: resetAt,
    errorMessage: `Rate limited until ${resetAt}`
  })
}

async function markAccountUnauthorized(id, message = 'Unauthorized') {
  await updateAccount(id, { status: 'unauthorized', schedulable: false, errorMessage: message })
}

async function markAccountError(id, message = 'Upstream error') {
  await updateAccount(id, { status: 'error', schedulable: false, errorMessage: message })
}

async function resetAccountStatus(id) {
  await updateAccount(id, {
    status: 'active',
    schedulable: true,
    errorMessage: '',
    rateLimitedAt: '',
    rateLimitResetAt: ''
  })
  return { success: true }
}

async function resetUsage(id) {
  await updateAccount(id, {
    dailyUsage: 0,
    lastResetDate: redis.getDateStringInTimezone(),
    quotaStoppedAt: ''
  })
  return { success: true }
}

module.exports = {
  getConfig,
  updateConfig,
  createAccount,
  getAccount,
  getAllAccounts,
  updateAccount,
  deleteAccount,
  selectAccountForModel,
  markAccountUsed,
  markAccountRateLimited,
  markAccountUnauthorized,
  markAccountError,
  resetAccountStatus,
  resetUsage,
  _normalizeMappings: normalizeMappings
}
```

- [ ] **Step 4: Run the account service tests to verify GREEN**

Run: `npm test -- tests/claudeOpenAIBridgeAccountService.test.js`

Expected: PASS.

- [ ] **Step 5: Commit account service**

```bash
git add tests/claudeOpenAIBridgeAccountService.test.js src/services/account/claudeOpenAIBridgeAccountService.js
git commit -m "feat: add Claude OpenAI bridge account service"
```

## Task 2: Pure Claude/OpenAI Conversion

**Files:**
- Create: `tests/claudeOpenAIBridgeConverter.test.js`
- Create: `src/services/claudeOpenAIBridgeConverter.js`

- [ ] **Step 1: Write the failing converter tests**

```javascript
const converter = require('../src/services/claudeOpenAIBridgeConverter')

describe('claudeOpenAIBridgeConverter', () => {
  it('converts Claude Messages request to OpenAI chat completions with mapped model and tools', () => {
    const result = converter.convertClaudeRequestToOpenAI(
      {
        model: 'deepseek-v4-flash',
        system: [{ type: 'text', text: 'You are concise.' }],
        messages: [
          { role: 'user', content: 'Weather?' },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will check.' },
              { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'Paris' } }
            ]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'Sunny' }]
          }
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Get weather',
            input_schema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city']
            }
          }
        ],
        tool_choice: { type: 'tool', name: 'get_weather' },
        max_tokens: 100,
        temperature: 0.8,
        top_p: 0.1,
        stop_sequences: ['STOP'],
        reasoning_effort: 'none',
        stream: false
      },
      'DeepSeek-V4-Flash'
    )

    expect(result).toMatchObject({
      model: 'DeepSeek-V4-Flash',
      max_tokens: 100,
      temperature: 0.8,
      top_p: 0.1,
      stop: ['STOP'],
      reasoning_effort: 'none',
      stream: false
    })
    expect(result.messages[0]).toEqual({ role: 'system', content: 'You are concise.' })
    expect(result.messages[2]).toMatchObject({
      role: 'assistant',
      content: 'I will check.',
      tool_calls: [
        {
          id: 'toolu_1',
          type: 'function',
          function: { name: 'get_weather', arguments: '{"city":"Paris"}' }
        }
      ]
    })
    expect(result.messages[3]).toEqual({
      role: 'tool',
      tool_call_id: 'toolu_1',
      content: 'Sunny'
    })
    expect(result.tools[0].function.name).toBe('get_weather')
    expect(result.tool_choice).toEqual({ type: 'function', function: { name: 'get_weather' } })
  })

  it('converts OpenAI non-stream text and tool calls to Claude message response', () => {
    const result = converter.convertOpenAIResponseToClaude(
      {
        id: 'chatcmpl_1',
        model: 'DeepSeek-V4-Flash',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'Done',
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'write_file', arguments: '{"path":"a.txt"}' }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 }
      },
      'deepseek-v4-flash'
    )

    expect(result).toMatchObject({
      id: 'chatcmpl_1',
      type: 'message',
      role: 'assistant',
      model: 'deepseek-v4-flash',
      stop_reason: 'tool_use',
      usage: { input_tokens: 11, output_tokens: 7 }
    })
    expect(result.content).toEqual([
      { type: 'text', text: 'Done' },
      { type: 'tool_use', id: 'call_1', name: 'write_file', input: { path: 'a.txt' } }
    ])
  })

  it('converts OpenAI stream chunks to Claude SSE events for text and usage', () => {
    const state = converter.createStreamState('deepseek-v4-flash')

    const first = converter.convertOpenAIStreamChunkToClaudeEvents(
      {
        id: 'chatcmpl_1',
        choices: [{ delta: { role: 'assistant', content: 'Hel' }, index: 0 }]
      },
      state
    )
    const second = converter.convertOpenAIStreamChunkToClaudeEvents(
      {
        choices: [{ delta: { content: 'lo' }, finish_reason: 'stop', index: 0 }],
        usage: { prompt_tokens: 3, completion_tokens: 2 }
      },
      state
    )

    expect(first.map((event) => event.type)).toEqual([
      'message_start',
      'content_block_start',
      'content_block_delta'
    ])
    expect(second.map((event) => event.type)).toEqual([
      'content_block_delta',
      'content_block_stop',
      'message_delta',
      'message_stop'
    ])
    expect(state.usage).toEqual({ input_tokens: 3, output_tokens: 2 })
  })
})
```

- [ ] **Step 2: Run the converter tests to verify RED**

Run: `npm test -- tests/claudeOpenAIBridgeConverter.test.js`

Expected: FAIL with `Cannot find module '../src/services/claudeOpenAIBridgeConverter'`.

- [ ] **Step 3: Implement the converter**

Create `src/services/claudeOpenAIBridgeConverter.js` with these functions:

```javascript
function textFromClaudeContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text || '')
    .join('')
}

function parseJsonObject(value) {
  if (!value) return {}
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function convertToolChoice(toolChoice) {
  if (!toolChoice) return undefined
  if (toolChoice.type === 'auto') return 'auto'
  if (toolChoice.type === 'none') return 'none'
  if (toolChoice.type === 'any') return 'required'
  if (toolChoice.type === 'tool') {
    return { type: 'function', function: { name: toolChoice.name } }
  }
  return undefined
}

function convertTools(tools = []) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || '',
      parameters: tool.input_schema || { type: 'object', properties: {} }
    }
  }))
}

function convertContentBlocksToOpenAI(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return textFromClaudeContent(content)
  const textParts = []
  const imageParts = []
  for (const part of content) {
    if (part?.type === 'text') {
      textParts.push({ type: 'text', text: part.text || '' })
    } else if (part?.type === 'image' && part.source?.type === 'base64') {
      imageParts.push({
        type: 'image_url',
        image_url: {
          url: `data:${part.source.media_type || 'image/png'};base64,${part.source.data || ''}`
        }
      })
    }
  }
  const parts = [...textParts, ...imageParts]
  if (parts.length === 0) return ''
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text
  return parts
}

function appendClaudeMessage(openaiMessages, message) {
  const content = message.content
  if (Array.isArray(content)) {
    const toolResults = content.filter((part) => part?.type === 'tool_result')
    if (toolResults.length > 0) {
      for (const result of toolResults) {
        openaiMessages.push({
          role: 'tool',
          tool_call_id: result.tool_use_id,
          content: textFromClaudeContent(result.content)
        })
      }
      return
    }
  }

  const openaiMessage = {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: convertContentBlocksToOpenAI(content)
  }

  if (Array.isArray(content)) {
    const toolCalls = content.filter((part) => part?.type === 'tool_use')
    if (toolCalls.length > 0) {
      openaiMessage.tool_calls = toolCalls.map((part) => ({
        id: part.id,
        type: 'function',
        function: {
          name: part.name,
          arguments: JSON.stringify(part.input || {})
        }
      }))
      const text = content.filter((part) => part?.type === 'text').map((part) => part.text || '').join('')
      openaiMessage.content = text || null
    }
  }

  openaiMessages.push(openaiMessage)
}

function convertClaudeRequestToOpenAI(claudeBody, targetModel) {
  const messages = []
  if (claudeBody.system) {
    const systemText = textFromClaudeContent(claudeBody.system)
    if (systemText) messages.push({ role: 'system', content: systemText })
  }
  for (const message of claudeBody.messages || []) appendClaudeMessage(messages, message)

  const body = {
    model: targetModel,
    messages,
    stream: claudeBody.stream === true
  }
  for (const key of ['max_tokens', 'temperature', 'top_p', 'presence_penalty', 'frequency_penalty', 'reasoning_effort']) {
    if (claudeBody[key] !== undefined) body[key] = claudeBody[key]
  }
  if (claudeBody.stop_sequences) body.stop = claudeBody.stop_sequences
  const tools = convertTools(claudeBody.tools)
  if (tools) body.tools = tools
  const toolChoice = convertToolChoice(claudeBody.tool_choice)
  if (toolChoice) body.tool_choice = toolChoice
  return body
}

function mapFinishReason(reason) {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  if (reason === 'content_filter') return 'stop_sequence'
  return 'end_turn'
}

function usageFromOpenAI(usage = {}) {
  return {
    input_tokens: usage.prompt_tokens || usage.input_tokens || 0,
    output_tokens: usage.completion_tokens || usage.output_tokens || 0
  }
}

function convertOpenAIMessageContent(message = {}) {
  const content = []
  if (typeof message.content === 'string' && message.content) {
    content.push({ type: 'text', text: message.content })
  }
  const calls = message.tool_calls || (message.function_call ? [{ id: 'call_0', function: message.function_call }] : [])
  for (const call of calls) {
    content.push({
      type: 'tool_use',
      id: call.id || `toolu_${Math.random().toString(36).slice(2)}`,
      name: call.function?.name || call.name,
      input: parseJsonObject(call.function?.arguments || call.arguments)
    })
  }
  return content.length > 0 ? content : [{ type: 'text', text: '' }]
}

function convertOpenAIResponseToClaude(openaiResponse, sourceModel) {
  const choice = openaiResponse.choices?.[0] || {}
  return {
    id: openaiResponse.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: sourceModel,
    content: convertOpenAIMessageContent(choice.message || {}),
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: usageFromOpenAI(openaiResponse.usage || {})
  }
}

function createStreamState(sourceModel) {
  return {
    sourceModel,
    messageStarted: false,
    currentContentIndex: -1,
    currentContentType: null,
    currentToolCalls: new Map(),
    stopReason: null,
    usage: null,
    completed: false
  }
}

function convertOpenAIStreamChunkToClaudeEvents(chunk, state) {
  const events = []
  if (!state.messageStarted) {
    state.messageStarted = true
    events.push({
      type: 'message_start',
      message: {
        id: chunk.id || `msg_${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model: state.sourceModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 }
      }
    })
  }

  if (chunk.usage) state.usage = usageFromOpenAI(chunk.usage)

  for (const choice of chunk.choices || []) {
    const delta = choice.delta || {}
    if (delta.content !== undefined) {
      if (state.currentContentType !== 'text') {
        if (state.currentContentType) events.push({ type: 'content_block_stop', index: state.currentContentIndex })
        state.currentContentIndex += 1
        state.currentContentType = 'text'
        events.push({
          type: 'content_block_start',
          index: state.currentContentIndex,
          content_block: { type: 'text', text: '' }
        })
      }
      events.push({
        type: 'content_block_delta',
        index: state.currentContentIndex,
        delta: { type: 'text_delta', text: delta.content || '' }
      })
    }

    for (const toolCall of delta.tool_calls || []) {
      const key = toolCall.index || 0
      let toolState = state.currentToolCalls.get(key)
      if (!toolState) {
        if (state.currentContentType) events.push({ type: 'content_block_stop', index: state.currentContentIndex })
        state.currentContentIndex += 1
        state.currentContentType = 'tool_use'
        toolState = {
          id: toolCall.id || `call_${key}`,
          name: toolCall.function?.name || '',
          arguments: ''
        }
        state.currentToolCalls.set(key, toolState)
        events.push({
          type: 'content_block_start',
          index: state.currentContentIndex,
          content_block: { type: 'tool_use', id: toolState.id, name: toolState.name, input: {} }
        })
      }
      if (toolCall.function?.name) toolState.name = toolCall.function.name
      if (toolCall.function?.arguments) {
        toolState.arguments += toolCall.function.arguments
        events.push({
          type: 'content_block_delta',
          index: state.currentContentIndex,
          delta: { type: 'input_json_delta', partial_json: toolCall.function.arguments }
        })
      }
    }

    if (choice.finish_reason) {
      state.stopReason = mapFinishReason(choice.finish_reason)
      if (state.currentContentType) {
        events.push({ type: 'content_block_stop', index: state.currentContentIndex })
        state.currentContentType = null
      }
      events.push({
        type: 'message_delta',
        delta: { stop_reason: state.stopReason, stop_sequence: null },
        usage: state.usage || { output_tokens: 0 }
      })
      events.push({ type: 'message_stop' })
      state.completed = true
    }
  }
  return events
}

module.exports = {
  convertClaudeRequestToOpenAI,
  convertOpenAIResponseToClaude,
  convertOpenAIStreamChunkToClaudeEvents,
  createStreamState,
  _usageFromOpenAI: usageFromOpenAI
}
```

- [ ] **Step 4: Run the converter tests to verify GREEN**

Run: `npm test -- tests/claudeOpenAIBridgeConverter.test.js`

Expected: PASS.

- [ ] **Step 5: Commit converter**

```bash
git add tests/claudeOpenAIBridgeConverter.test.js src/services/claudeOpenAIBridgeConverter.js
git commit -m "feat: convert Claude messages for OpenAI bridge"
```

## Task 3: Relay Service

**Files:**
- Create: `tests/claudeOpenAIBridgeRelayService.test.js`
- Create: `src/services/relay/claudeOpenAIBridgeRelayService.js`

- [ ] **Step 1: Write the failing relay tests**

```javascript
const { PassThrough } = require('stream')
const EventEmitter = require('events')

jest.mock('axios', () => jest.fn())

jest.mock('../src/services/account/claudeOpenAIBridgeAccountService', () => ({
  markAccountUsed: jest.fn(),
  markAccountRateLimited: jest.fn(),
  markAccountUnauthorized: jest.fn(),
  markAccountError: jest.fn(),
  updateAccount: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordUsage: jest.fn()
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn()
}))

jest.mock('../config/config', () => ({ requestTimeout: 60000 }))

const axios = require('axios')
const accountService = require('../src/services/account/claudeOpenAIBridgeAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')
const relay = require('../src/services/relay/claudeOpenAIBridgeRelayService')

function createReq(body) {
  const req = new EventEmitter()
  req.body = body
  req.headers = { 'user-agent': 'test-client' }
  req.apiKey = { id: 'key-1', name: 'Key One' }
  req.rateLimitInfo = { enabled: true }
  req.path = '/v1/messages'
  req.originalUrl = '/api/v1/messages'
  return req
}

function createRes() {
  const res = new EventEmitter()
  res.statusCode = 200
  res.headersSent = false
  res.destroyed = false
  res.status = jest.fn((code) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn(() => res)
  res.setHeader = jest.fn()
  res.write = jest.fn()
  res.end = jest.fn()
  return res
}

describe('claudeOpenAIBridgeRelayService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.recordUsage.mockResolvedValue({ totalCost: 0.01 })
    updateRateLimitCounters.mockResolvedValue({ totalTokens: 9, totalCost: 0.01 })
  })

  it('posts converted non-stream request and returns Claude response with usage recorded', async () => {
    axios.mockResolvedValue({
      status: 200,
      headers: { 'x-request-id': 'up-1' },
      data: {
        id: 'chatcmpl_1',
        choices: [{ message: { content: 'Bonjour' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 4, completion_tokens: 5, total_tokens: 9 }
      }
    })

    const req = createReq({
      model: 'deepseek-v4-flash',
      max_tokens: 20,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const res = createRes()

    await relay.handleRequest(req, res, {
      account: {
        id: 'bridge-1',
        name: 'Azure Bridge',
        endpointUrl: 'https://bc-openai-1.openai.azure.com/openai/v1/chat/completions',
        apiKey: 'upstream-key',
        dailyQuota: 0
      },
      mapping: { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash' }
    })

    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://bc-openai-1.openai.azure.com/openai/v1/chat/completions',
        data: expect.objectContaining({ model: 'DeepSeek-V4-Flash' }),
        headers: expect.objectContaining({ Authorization: 'Bearer upstream-key' })
      })
    )
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'message',
        model: 'deepseek-v4-flash',
        content: [{ type: 'text', text: 'Bonjour' }],
        usage: { input_tokens: 4, output_tokens: 5 }
      })
    )
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-1',
      4,
      5,
      0,
      0,
      'deepseek-v4-flash',
      'bridge-1',
      'claude-openai-bridge',
      null,
      expect.any(Object)
    )
    expect(accountService.markAccountUsed).toHaveBeenCalledWith('bridge-1')
    expect(updateRateLimitCounters).toHaveBeenCalled()
  })

  it('converts OpenAI stream chunks to Claude SSE and records terminal usage', async () => {
    const stream = new PassThrough()
    axios.mockResolvedValue({
      status: 200,
      headers: {},
      data: stream
    })
    const req = createReq({
      model: 'deepseek-v4-flash',
      stream: true,
      messages: [{ role: 'user', content: 'hi' }]
    })
    const res = createRes()

    const promise = relay.handleRequest(req, res, {
      account: {
        id: 'bridge-1',
        name: 'Azure Bridge',
        endpointUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'upstream-key',
        dailyQuota: 0
      },
      mapping: { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash' }
    })

    await new Promise((resolve) => setImmediate(resolve))
    stream.write('data: {"id":"chatcmpl_1","choices":[{"delta":{"role":"assistant","content":"Hi"},"index":0}]}\n\n')
    stream.write('data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}],"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\n')
    stream.write('data: [DONE]\n\n')
    stream.end()
    await promise

    const output = res.write.mock.calls.map((call) => call[0]).join('')
    expect(output).toContain('event: message_start')
    expect(output).toContain('event: content_block_delta')
    expect(output).toContain('event: message_stop')
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-1',
      2,
      1,
      0,
      0,
      'deepseek-v4-flash',
      'bridge-1',
      'claude-openai-bridge',
      null,
      expect.any(Object)
    )
  })

  it('marks bridge account rate limited on upstream 429', async () => {
    axios.mockResolvedValue({
      status: 429,
      headers: { 'retry-after': '120' },
      data: { error: { message: 'rate limited' } }
    })
    const req = createReq({ model: 'kimi-k2.6', messages: [{ role: 'user', content: 'hi' }] })
    const res = createRes()

    await relay.handleRequest(req, res, {
      account: {
        id: 'bridge-2',
        name: 'Bridge',
        endpointUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'key'
      },
      mapping: { sourceModel: 'kimi-k2.6', targetModel: 'Kimi-K2.6' }
    })

    expect(accountService.markAccountRateLimited).toHaveBeenCalledWith('bridge-2', 2)
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(Object) }))
  })
})
```

- [ ] **Step 2: Run the relay tests to verify RED**

Run: `npm test -- tests/claudeOpenAIBridgeRelayService.test.js`

Expected: FAIL with `Cannot find module '../src/services/relay/claudeOpenAIBridgeRelayService'`.

- [ ] **Step 3: Implement the relay service**

Create `src/services/relay/claudeOpenAIBridgeRelayService.js` with:

```javascript
const axios = require('axios')
const config = require('../../../config/config')
const logger = require('../../utils/logger')
const ProxyHelper = require('../../utils/proxyHelper')
const apiKeyService = require('../apiKeyService')
const bridgeAccountService = require('../account/claudeOpenAIBridgeAccountService')
const converter = require('../claudeOpenAIBridgeConverter')
const { updateRateLimitCounters } = require('../../utils/rateLimitHelper')
const { createRequestDetailMeta } = require('../../utils/requestDetailHelper')

function parseRetryAfterMinutes(headers = {}) {
  const retryAfter = headers['retry-after'] || headers['Retry-After']
  const seconds = Number(retryAfter)
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds / 60) : null
}

function writeSSE(res, event) {
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

function parseSSEBuffer(buffer) {
  const parts = buffer.split('\n\n')
  return { complete: parts.slice(0, -1), rest: parts[parts.length - 1] }
}

async function recordUsage(req, res, account, sourceModel, usage) {
  if (!req.apiKey?.id || !usage) return null
  const inputTokens = usage.input_tokens || 0
  const outputTokens = usage.output_tokens || 0
  const costs = await apiKeyService.recordUsage(
    req.apiKey.id,
    inputTokens,
    outputTokens,
    0,
    0,
    sourceModel,
    account.id,
    'claude-openai-bridge',
    null,
    createRequestDetailMeta(req, {
      requestBody: req.body,
      stream: req.body?.stream === true,
      statusCode: res.statusCode
    })
  )
  if (req.rateLimitInfo) {
    await updateRateLimitCounters(
      req.rateLimitInfo,
      { inputTokens, outputTokens, cacheCreateTokens: 0, cacheReadTokens: 0 },
      sourceModel,
      req.apiKey.id,
      'claude-openai-bridge',
      costs
    )
  }
  return costs
}

async function handleErrorStatus(response, res, account) {
  const status = response.status
  if (status === 429) {
    await bridgeAccountService.markAccountRateLimited(
      account.id,
      parseRetryAfterMinutes(response.headers)
    )
  } else if (status === 401 || status === 403) {
    await bridgeAccountService.markAccountUnauthorized(account.id, response.data?.error?.message || 'Unauthorized')
  } else if (status >= 500) {
    await bridgeAccountService.markAccountError(account.id, response.data?.error?.message || 'Upstream error')
  }
  return res.status(status).json({
    error: {
      type: 'api_error',
      message: response.data?.error?.message || response.data?.message || `Upstream returned ${status}`
    }
  })
}

async function handleNormal(req, res, account, mapping, axiosConfig) {
  const openaiBody = converter.convertClaudeRequestToOpenAI(req.body, mapping.targetModel)
  const response = await axios({
    ...axiosConfig,
    method: 'POST',
    url: account.endpointUrl,
    data: openaiBody,
    responseType: 'json'
  })
  if (response.status >= 400) return handleErrorStatus(response, res, account)
  const claudeResponse = converter.convertOpenAIResponseToClaude(response.data, mapping.sourceModel)
  await recordUsage(req, res, account, mapping.sourceModel, claudeResponse.usage)
  await bridgeAccountService.markAccountUsed(account.id)
  res.status(response.status)
  return res.json(claudeResponse)
}

async function handleStream(req, res, account, mapping, axiosConfig) {
  const openaiBody = converter.convertClaudeRequestToOpenAI(req.body, mapping.targetModel)
  const response = await axios({
    ...axiosConfig,
    method: 'POST',
    url: account.endpointUrl,
    data: openaiBody,
    responseType: 'stream'
  })
  if (response.status >= 400) return handleErrorStatus(response, res, account)

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')

  const state = converter.createStreamState(mapping.sourceModel)
  let buffer = ''
  let wroteAny = false
  return new Promise((resolve) => {
    response.data.on('data', (chunk) => {
      buffer += chunk.toString()
      const parsed = parseSSEBuffer(buffer)
      buffer = parsed.rest
      for (const block of parsed.complete) {
        const dataLine = block.split('\n').find((line) => line.startsWith('data: '))
        if (!dataLine) continue
        const data = dataLine.slice(6).trim()
        if (!data || data === '[DONE]') continue
        try {
          const openaiChunk = JSON.parse(data)
          const events = converter.convertOpenAIStreamChunkToClaudeEvents(openaiChunk, state)
          for (const event of events) {
            writeSSE(res, event)
            wroteAny = true
          }
        } catch (error) {
          logger.warn('Failed to parse bridge upstream SSE chunk', { message: error.message })
        }
      }
    })
    response.data.on('end', async () => {
      try {
        if (!state.completed) {
          if (wroteAny) {
            writeSSE(res, {
              type: 'error',
              error: { type: 'api_error', message: 'Upstream stream ended before completion' }
            })
          } else if (!res.headersSent) {
            res.status(502).json({ error: { message: 'Upstream stream ended before completion' } })
            return resolve()
          }
        }
        if (state.usage) await recordUsage(req, res, account, mapping.sourceModel, state.usage)
        await bridgeAccountService.markAccountUsed(account.id)
        res.end()
      } catch (error) {
        logger.error('Failed to finalize bridge stream', error)
        res.end()
      }
      resolve()
    })
    response.data.on('error', (error) => {
      logger.error('Claude OpenAI bridge stream error', { message: error.message })
      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'Upstream stream error' } })
      } else {
        res.end()
      }
      resolve()
    })
  })
}

async function handleRequest(req, res, selection) {
  const { account, mapping } = selection
  logger.info('🌉 Claude OpenAI bridge handoff', {
    route: req.path || '/v1/messages',
    sourceService: 'claude-messages',
    sourceModel: mapping.sourceModel,
    bridgeAccountId: account.id,
    bridgeAccountName: account.name,
    targetEndpoint: account.endpointUrl,
    targetModel: mapping.targetModel,
    stream: req.body?.stream === true,
    apiKeyClaudeBinding: {
      claudeAccountId: req.apiKey?.claudeAccountId || null,
      claudeConsoleAccountId: req.apiKey?.claudeConsoleAccountId || null,
      claudeVertexAccountId: req.apiKey?.claudeVertexAccountId || null
    }
  })

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${account.apiKey}`
  }
  if (req.headers?.['user-agent']) headers['User-Agent'] = req.headers['user-agent']

  const axiosConfig = {
    headers,
    timeout: config.requestTimeout || 600000,
    validateStatus: () => true
  }
  const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
  if (proxyAgent) {
    axiosConfig.httpAgent = proxyAgent
    axiosConfig.httpsAgent = proxyAgent
    axiosConfig.proxy = false
  }

  if (req.body?.stream === true) return handleStream(req, res, account, mapping, axiosConfig)
  return handleNormal(req, res, account, mapping, axiosConfig)
}

module.exports = { handleRequest, _recordUsage: recordUsage }
```

- [ ] **Step 4: Run relay tests to verify GREEN**

Run: `npm test -- tests/claudeOpenAIBridgeRelayService.test.js`

Expected: PASS.

- [ ] **Step 5: Commit relay service**

```bash
git add tests/claudeOpenAIBridgeRelayService.test.js src/services/relay/claudeOpenAIBridgeRelayService.js
git commit -m "feat: relay Claude messages to OpenAI bridge"
```

## Task 4: `/api/v1/messages` Bridge Routing

**Files:**
- Create: `tests/api.claudeOpenAIBridgeRouting.test.js`
- Modify: `src/routes/api.js`

- [ ] **Step 1: Write the failing routing tests**

```javascript
jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn()
}))
jest.mock('../src/services/account/claudeOpenAIBridgeAccountService', () => ({
  selectAccountForModel: jest.fn()
}))
jest.mock('../src/services/relay/claudeOpenAIBridgeRelayService', () => ({
  handleRequest: jest.fn()
}))
jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn()
}))
jest.mock('../src/services/claudeRelayConfigService', () => ({
  isGlobalSessionBindingEnabled: jest.fn().mockResolvedValue(false)
}))
jest.mock('../src/utils/anthropicRequestDump', () => ({
  dumpAnthropicMessagesRequest: jest.fn()
}))
jest.mock('../src/services/anthropicGeminiBridgeService', () => ({
  handleAnthropicMessagesToGemini: jest.fn(),
  handleAnthropicCountTokensToGemini: jest.fn()
}))
jest.mock('../src/services/relay/claudeRelayService', () => ({}))
jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({}))
jest.mock('../src/services/relay/bedrockRelayService', () => ({}))
jest.mock('../src/services/relay/gcpVertexRelayService', () => ({}))
jest.mock('../src/services/relay/ccrRelayService', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))
jest.mock('../src/services/account/gcpVertexAccountService', () => ({}))
jest.mock('../src/services/account/bedrockAccountService', () => ({}))
jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

const apiKeyService = require('../src/services/apiKeyService')
const bridgeAccountService = require('../src/services/account/claudeOpenAIBridgeAccountService')
const bridgeRelay = require('../src/services/relay/claudeOpenAIBridgeRelayService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')

function createReq(body) {
  return {
    body,
    headers: {},
    apiKey: { id: 'key-1', name: 'Key One', permissions: [], enableModelRestriction: false },
    path: '/v1/messages',
    url: '/v1/messages',
    originalUrl: '/api/v1/messages'
  }
}

function createRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    end: jest.fn(),
    destroyed: false,
    socket: { destroyed: false, setNoDelay: jest.fn() }
  }
}

describe('/api/v1/messages Claude OpenAI bridge routing', () => {
  let handleMessagesRequest

  beforeEach(() => {
    jest.resetModules()
    jest.clearAllMocks()
    apiKeyService.hasPermission.mockReturnValue(true)
    const router = require('../src/routes/api')
    const routeLayer = router.stack.find(
      (layer) => layer.route && layer.route.path === '/v1/messages' && layer.route.methods.post
    )
    handleMessagesRequest = routeLayer.route.stack[1].handle
  })

  it('calls bridge relay when source model matches an enabled bridge mapping', async () => {
    const selection = {
      account: { id: 'bridge-1', name: 'Bridge' },
      mapping: { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash' }
    }
    bridgeAccountService.selectAccountForModel.mockResolvedValue(selection)
    bridgeRelay.handleRequest.mockResolvedValue(undefined)

    const req = createReq({
      model: 'deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }]
    })
    const res = createRes()

    await handleMessagesRequest(req, res)

    expect(bridgeAccountService.selectAccountForModel).toHaveBeenCalledWith('deepseek-v4-flash')
    expect(bridgeRelay.handleRequest).toHaveBeenCalledWith(req, res, selection)
    expect(unifiedClaudeScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  })

  it('continues to current scheduler behavior when bridge has no mapping', async () => {
    bridgeAccountService.selectAccountForModel.mockResolvedValue(null)
    unifiedClaudeScheduler.selectAccountForApiKey.mockRejectedValue(new Error('scheduler reached'))

    const req = createReq({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'user', content: 'hi' }]
    })
    const res = createRes()

    await expect(handleMessagesRequest(req, res)).rejects.toThrow('scheduler reached')
    expect(bridgeRelay.handleRequest).not.toHaveBeenCalled()
    expect(unifiedClaudeScheduler.selectAccountForApiKey).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run routing tests to verify RED**

Run: `npm test -- tests/api.claudeOpenAIBridgeRouting.test.js`

Expected: FAIL because `claudeOpenAIBridgeAccountService` does not exist in `src/routes/api.js` and the bridge relay is not called.

- [ ] **Step 3: Wire bridge routing into `src/routes/api.js`**

Add imports near the existing service imports:

```javascript
const claudeOpenAIBridgeAccountService = require('../services/account/claudeOpenAIBridgeAccountService')
const claudeOpenAIBridgeRelayService = require('../services/relay/claudeOpenAIBridgeRelayService')
```

After the forced Gemini branch and before `const isStream = req.body.stream === true`, add:

```javascript
    const bridgeSelection = await claudeOpenAIBridgeAccountService.selectAccountForModel(
      req.body.model || ''
    )
    if (bridgeSelection) {
      logger.api('🌉 /v1/messages matched Claude OpenAI bridge mapping', {
        sourceModel: req.body.model || null,
        targetModel: bridgeSelection.mapping?.targetModel || null,
        bridgeAccountId: bridgeSelection.account?.id || null,
        bridgeAccountName: bridgeSelection.account?.name || null,
        stream: req.body.stream === true
      })
      return await claudeOpenAIBridgeRelayService.handleRequest(req, res, bridgeSelection)
    }
```

- [ ] **Step 4: Run routing tests to verify GREEN**

Run: `npm test -- tests/api.claudeOpenAIBridgeRouting.test.js`

Expected: PASS.

- [ ] **Step 5: Commit routing**

```bash
git add tests/api.claudeOpenAIBridgeRouting.test.js src/routes/api.js
git commit -m "feat: route mapped Claude models through OpenAI bridge"
```

## Task 5: Admin Routes

**Files:**
- Create: `tests/admin.claudeOpenAIBridgeAccounts.test.js`
- Create: `src/routes/admin/claudeOpenAIBridgeAccounts.js`
- Modify: `src/routes/admin/index.js`

- [ ] **Step 1: Write the failing admin route tests**

```javascript
const request = require('supertest')
const express = require('express')

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))

jest.mock('../src/services/account/claudeOpenAIBridgeAccountService', () => ({
  getConfig: jest.fn(),
  updateConfig: jest.fn(),
  getAllAccounts: jest.fn(),
  createAccount: jest.fn(),
  getAccount: jest.fn(),
  updateAccount: jest.fn(),
  deleteAccount: jest.fn(),
  resetAccountStatus: jest.fn(),
  resetUsage: jest.fn()
}))

jest.mock('axios', () => jest.fn())

jest.mock('../src/utils/proxyHelper', () => ({
  getProxyAgent: jest.fn(),
  createProxyAgent: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

const axios = require('axios')
const service = require('../src/services/account/claudeOpenAIBridgeAccountService')

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/admin', require('../src/routes/admin/claudeOpenAIBridgeAccounts'))
  return app
}

describe('admin Claude OpenAI bridge routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('gets and updates global config', async () => {
    service.getConfig.mockResolvedValue({ enabled: false })
    service.updateConfig.mockResolvedValue({ enabled: true })
    const app = createApp()

    await request(app).get('/admin/claude-openai-bridge/config').expect(200, {
      success: true,
      data: { enabled: false }
    })

    await request(app)
      .put('/admin/claude-openai-bridge/config')
      .send({ enabled: true })
      .expect(200, { success: true, data: { enabled: true } })
  })

  it('creates, lists, updates, and deletes bridge accounts', async () => {
    const account = {
      id: 'bridge-1',
      name: 'Bridge',
      endpointUrl: 'https://example.com/v1/chat/completions',
      apiKey: '***',
      modelMappings: []
    }
    service.getAllAccounts.mockResolvedValue([account])
    service.createAccount.mockResolvedValue(account)
    service.updateAccount.mockResolvedValue({ success: true })
    service.deleteAccount.mockResolvedValue({ success: true })
    const app = createApp()

    await request(app).get('/admin/claude-openai-bridge/accounts').expect(200, {
      success: true,
      data: [account]
    })

    await request(app)
      .post('/admin/claude-openai-bridge/accounts')
      .send({
        name: 'Bridge',
        endpointUrl: 'https://example.com/v1/chat/completions',
        apiKey: 'secret',
        modelMappings: [{ sourceModel: 'grok-4.3', targetModel: 'grok-4.3', enabled: true }]
      })
      .expect(200, { success: true, data: account })

    await request(app)
      .put('/admin/claude-openai-bridge/accounts/bridge-1')
      .send({ name: 'Updated' })
      .expect(200, { success: true, data: { success: true } })

    await request(app)
      .delete('/admin/claude-openai-bridge/accounts/bridge-1')
      .expect(200, { success: true, data: { success: true } })
  })

  it('tests a bridge account using endpoint URL, API key, and target model', async () => {
    service.getAccount.mockResolvedValue({
      id: 'bridge-1',
      name: 'Bridge',
      endpointUrl: 'https://example.com/v1/chat/completions',
      apiKey: 'secret',
      modelMappings: [{ sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash', enabled: true }]
    })
    axios.mockResolvedValue({
      status: 200,
      data: { choices: [{ message: { content: 'ok' } }] }
    })
    const app = createApp()

    await request(app)
      .post('/admin/claude-openai-bridge/accounts/bridge-1/test')
      .send({})
      .expect(200)

    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://example.com/v1/chat/completions',
        headers: expect.objectContaining({ Authorization: 'Bearer secret' }),
        data: expect.objectContaining({ model: 'DeepSeek-V4-Flash' })
      })
    )
  })
})
```

- [ ] **Step 2: Run admin tests to verify RED**

Run: `npm test -- tests/admin.claudeOpenAIBridgeAccounts.test.js`

Expected: FAIL with `Cannot find module '../src/routes/admin/claudeOpenAIBridgeAccounts'`.

- [ ] **Step 3: Implement admin routes**

Create `src/routes/admin/claudeOpenAIBridgeAccounts.js`:

```javascript
const express = require('express')
const axios = require('axios')
const { authenticateAdmin } = require('../../middleware/auth')
const service = require('../../services/account/claudeOpenAIBridgeAccountService')
const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')

const router = express.Router()

router.get('/claude-openai-bridge/config', authenticateAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await service.getConfig() })
  } catch (error) {
    logger.error('Failed to get Claude OpenAI bridge config:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

router.put('/claude-openai-bridge/config', authenticateAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await service.updateConfig(req.body || {}) })
  } catch (error) {
    logger.error('Failed to update Claude OpenAI bridge config:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

router.get('/claude-openai-bridge/accounts', authenticateAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await service.getAllAccounts(true) })
  } catch (error) {
    logger.error('Failed to get Claude OpenAI bridge accounts:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

router.post('/claude-openai-bridge/accounts', authenticateAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await service.createAccount(req.body || {}) })
  } catch (error) {
    logger.error('Failed to create Claude OpenAI bridge account:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

router.put('/claude-openai-bridge/accounts/:id', authenticateAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await service.updateAccount(req.params.id, req.body || {}) })
  } catch (error) {
    logger.error('Failed to update Claude OpenAI bridge account:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

router.delete('/claude-openai-bridge/accounts/:id', authenticateAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await service.deleteAccount(req.params.id) })
  } catch (error) {
    logger.error('Failed to delete Claude OpenAI bridge account:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

router.put('/claude-openai-bridge/accounts/:id/toggle', authenticateAdmin, async (req, res) => {
  try {
    const account = await service.getAccount(req.params.id)
    if (!account) return res.status(404).json({ success: false, message: 'Account not found' })
    const result = await service.updateAccount(req.params.id, { isActive: !account.isActive })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Failed to toggle Claude OpenAI bridge account:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

router.put('/claude-openai-bridge/accounts/:id/toggle-schedulable', authenticateAdmin, async (req, res) => {
  try {
    const account = await service.getAccount(req.params.id)
    if (!account) return res.status(404).json({ success: false, message: 'Account not found' })
    const result = await service.updateAccount(req.params.id, { schedulable: account.schedulable === false || account.schedulable === 'false' })
    res.json({ success: true, data: result })
  } catch (error) {
    logger.error('Failed to toggle Claude OpenAI bridge schedulable:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

router.post('/claude-openai-bridge/accounts/:id/reset-status', authenticateAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await service.resetAccountStatus(req.params.id) })
  } catch (error) {
    logger.error('Failed to reset Claude OpenAI bridge status:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

router.post('/claude-openai-bridge/accounts/:id/reset-usage', authenticateAdmin, async (req, res) => {
  try {
    res.json({ success: true, data: await service.resetUsage(req.params.id) })
  } catch (error) {
    logger.error('Failed to reset Claude OpenAI bridge usage:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

router.post('/claude-openai-bridge/accounts/:id/test', authenticateAdmin, async (req, res) => {
  try {
    const account = await service.getAccount(req.params.id)
    if (!account) return res.status(404).json({ success: false, message: 'Account not found' })
    const mapping = account.modelMappings.find((item) => item.enabled) || {}
    const model = req.body?.targetModel || mapping.targetModel
    if (!model) return res.status(400).json({ success: false, message: 'No target model configured' })
    const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
    const startedAt = Date.now()
    const response = await axios({
      method: 'POST',
      url: account.endpointUrl,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${account.apiKey}` },
      data: { model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false },
      timeout: 30000,
      validateStatus: () => true,
      ...(proxyAgent ? { httpAgent: proxyAgent, httpsAgent: proxyAgent, proxy: false } : {})
    })
    res.status(response.status >= 400 ? response.status : 200).json({
      success: response.status < 400,
      data: { status: response.status, latency: Date.now() - startedAt, response: response.data }
    })
  } catch (error) {
    logger.error('Failed to test Claude OpenAI bridge account:', error)
    res.status(500).json({ success: false, message: error.message })
  }
})

module.exports = router
```

Modify `src/routes/admin/index.js`:

```javascript
const claudeOpenAIBridgeAccountsRoutes = require('./claudeOpenAIBridgeAccounts')
```

Mount with direct routes:

```javascript
router.use('/', claudeOpenAIBridgeAccountsRoutes)
```

- [ ] **Step 4: Run admin tests to verify GREEN**

Run: `npm test -- tests/admin.claudeOpenAIBridgeAccounts.test.js`

Expected: PASS.

- [ ] **Step 5: Commit admin routes**

```bash
git add tests/admin.claudeOpenAIBridgeAccounts.test.js src/routes/admin/claudeOpenAIBridgeAccounts.js src/routes/admin/index.js
git commit -m "feat: manage Claude OpenAI bridge accounts"
```

## Task 6: Admin SPA API And Store Wiring

**Files:**
- Modify: `web/admin-spa/src/utils/http_apis.js`
- Modify: `web/admin-spa/src/stores/accounts.js`

- [ ] **Step 1: Add API helper tests by running build check first**

Run: `npm run build:web`

Expected before changes: PASS. This establishes the frontend baseline.

- [ ] **Step 2: Add bridge API helpers to `web/admin-spa/src/utils/http_apis.js`**

Append near the OpenAI Responses helpers:

```javascript
// Claude OpenAI Bridge
export const getClaudeOpenAIBridgeConfigApi = () =>
  request({ url: '/admin/claude-openai-bridge/config', method: 'GET' })
export const updateClaudeOpenAIBridgeConfigApi = (data) =>
  request({ url: '/admin/claude-openai-bridge/config', method: 'PUT', data })
export const getClaudeOpenAIBridgeAccountsApi = () =>
  request({ url: '/admin/claude-openai-bridge/accounts', method: 'GET' })
export const createClaudeOpenAIBridgeAccountApi = (data) =>
  request({ url: '/admin/claude-openai-bridge/accounts', method: 'POST', data })
export const updateClaudeOpenAIBridgeAccountApi = (id, data) =>
  request({ url: `/admin/claude-openai-bridge/accounts/${id}`, method: 'PUT', data })
```

- [ ] **Step 3: Add bridge state and actions to `web/admin-spa/src/stores/accounts.js`**

Update `PLATFORM_CONFIG`:

```javascript
  'claude-openai-bridge': {
    endpoint: 'claude-openai-bridge/accounts',
    stateKey: 'claudeOpenAIBridgeAccounts'
  },
```

Add state:

```javascript
  const claudeOpenAIBridgeAccounts = ref([])
  const claudeOpenAIBridgeConfig = ref({ enabled: false })
```

Add to `stateMap`:

```javascript
    claudeOpenAIBridgeAccounts,
```

Add fetch/create/update actions:

```javascript
  const fetchClaudeOpenAIBridgeConfig = async () => {
    const res = await httpApis.getClaudeOpenAIBridgeConfigApi()
    if (res.success) claudeOpenAIBridgeConfig.value = res.data || { enabled: false }
    else error.value = res.message
    return res
  }
  const updateClaudeOpenAIBridgeConfig = async (data) => {
    const res = await httpApis.updateClaudeOpenAIBridgeConfigApi(data)
    if (res.success) claudeOpenAIBridgeConfig.value = res.data || { enabled: false }
    else error.value = res.message
    return res
  }
  const fetchClaudeOpenAIBridgeAccounts = () =>
    fetchAccounts(httpApis.getClaudeOpenAIBridgeAccountsApi, claudeOpenAIBridgeAccounts)
  const createClaudeOpenAIBridgeAccount = (data) =>
    mutateAccount(httpApis.createClaudeOpenAIBridgeAccountApi, fetchClaudeOpenAIBridgeAccounts, data)
  const updateClaudeOpenAIBridgeAccount = (id, data) =>
    mutateAccount(httpApis.updateClaudeOpenAIBridgeAccountApi, fetchClaudeOpenAIBridgeAccounts, id, data)
```

Include `fetchClaudeOpenAIBridgeAccounts()` and `fetchClaudeOpenAIBridgeConfig()` in `fetchAllAccounts`.

Add bridge handling in `deleteAccount` `fetchMap`:

```javascript
        'claude-openai-bridge': fetchClaudeOpenAIBridgeAccounts,
```

Add bridge refs/actions to the returned object.

- [ ] **Step 4: Build frontend to verify store/helper wiring**

Run: `npm run build:web`

Expected: PASS.

- [ ] **Step 5: Commit frontend API/store wiring**

```bash
git add web/admin-spa/src/utils/http_apis.js web/admin-spa/src/stores/accounts.js
git commit -m "feat: wire Claude OpenAI bridge admin APIs"
```

## Task 7: Admin SPA Account UI

**Files:**
- Modify: `web/admin-spa/src/views/AccountsView.vue`
- Modify: `web/admin-spa/src/components/accounts/AccountForm.vue`

- [ ] **Step 1: Add bridge platform to `AccountForm.vue` platform selection**

In the Claude platform group template, add this label after CCR:

```vue
<label
  class="group relative flex cursor-pointer items-center rounded-md border p-2 transition-all"
  :class="[
    form.platform === 'claude-openai-bridge'
      ? 'border-slate-500 bg-slate-50 dark:border-slate-400 dark:bg-slate-900/30'
      : 'border-gray-300 bg-white hover:border-slate-400 hover:bg-slate-50/50 dark:border-gray-600 dark:bg-gray-700 dark:hover:border-slate-500 dark:hover:bg-slate-900/20'
  ]"
>
  <input v-model="form.platform" class="sr-only" type="radio" value="claude-openai-bridge" />
  <div class="flex items-center gap-2">
    <i class="fas fa-exchange-alt text-sm text-slate-600 dark:text-slate-400"></i>
    <div>
      <span class="block text-xs font-medium text-gray-900 dark:text-gray-100">Claude OpenAI Bridge</span>
      <span class="text-xs text-gray-500 dark:text-gray-400">Chat Completions</span>
    </div>
  </div>
  <div
    v-if="form.platform === 'claude-openai-bridge'"
    class="absolute right-1 top-1 flex h-4 w-4 items-center justify-center rounded-full bg-slate-500"
  >
    <i class="fas fa-check text-xs text-white"></i>
  </div>
</label>
```

- [ ] **Step 2: Add bridge form fields to `AccountForm.vue`**

Add a bridge-specific block in both create and edit form areas near `openai-responses` fields:

```vue
<div v-if="form.platform === 'claude-openai-bridge'" class="space-y-4">
  <div>
    <label class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
      Endpoint URL
    </label>
    <input
      v-model="form.endpointUrl"
      class="input-text"
      :class="{ 'border-red-500': errors.endpointUrl }"
      placeholder="https://bc-openai-1.openai.azure.com/openai/v1/chat/completions"
      type="url"
    />
    <p v-if="errors.endpointUrl" class="mt-1 text-xs text-red-500">{{ errors.endpointUrl }}</p>
  </div>

  <div>
    <label class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">API Key</label>
    <input
      v-model="form.apiKey"
      class="input-text"
      :class="{ 'border-red-500': errors.apiKey }"
      placeholder="sk-..."
      type="password"
    />
    <p v-if="errors.apiKey" class="mt-1 text-xs text-red-500">{{ errors.apiKey }}</p>
  </div>

  <div>
    <label class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
      模型映射
    </label>
    <div class="space-y-2">
      <div
        v-for="(mapping, index) in form.modelMappings"
        :key="index"
        class="grid grid-cols-[1fr_1fr_auto_auto] gap-2"
      >
        <input v-model="mapping.sourceModel" class="input-text" placeholder="deepseek-v4-flash" />
        <input v-model="mapping.targetModel" class="input-text" placeholder="DeepSeek-V4-Flash" />
        <label class="flex items-center gap-1 text-sm text-gray-600 dark:text-gray-300">
          <input v-model="mapping.enabled" type="checkbox" />
          启用
        </label>
        <button class="btn-secondary px-2" type="button" @click="removeBridgeModelMapping(index)">
          <i class="fas fa-trash" />
        </button>
      </div>
    </div>
    <button class="btn-secondary mt-2" type="button" @click="addBridgeModelMapping">
      <i class="fas fa-plus mr-1" />
      添加映射
    </button>
    <p v-if="errors.modelMappings" class="mt-1 text-xs text-red-500">{{ errors.modelMappings }}</p>
  </div>

  <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
    <div>
      <label class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">优先级</label>
      <input v-model.number="form.priority" class="input-text" min="1" max="100" type="number" />
    </div>
    <div>
      <label class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">每日限额 ($)</label>
      <input v-model.number="form.dailyQuota" class="input-text" min="0" step="0.01" type="number" />
    </div>
  </div>

  <div>
    <label class="mb-2 block text-sm font-medium text-gray-700 dark:text-gray-300">
      限流保护时长 (分钟)
    </label>
    <input v-model.number="form.rateLimitDuration" class="input-text" min="0" type="number" />
  </div>
</div>
```

Add script helpers:

```javascript
const defaultBridgeMappings = () => [
  { sourceModel: 'deepseek-v4-pro', targetModel: 'DeepSeek-V4-Pro', enabled: true },
  { sourceModel: 'deepseek-v4-flash', targetModel: 'DeepSeek-V4-Flash', enabled: true },
  { sourceModel: 'kimi-k2.6', targetModel: 'Kimi-K2.6', enabled: true },
  { sourceModel: 'grok-4.3', targetModel: 'grok-4.3', enabled: true }
]

const addBridgeModelMapping = () => {
  form.value.modelMappings.push({ sourceModel: '', targetModel: '', enabled: true })
}

const removeBridgeModelMapping = (index) => {
  form.value.modelMappings.splice(index, 1)
}

const cleanBridgeMappings = () =>
  (form.value.modelMappings || [])
    .map((mapping) => ({
      sourceModel: (mapping.sourceModel || '').trim(),
      targetModel: (mapping.targetModel || '').trim(),
      enabled: mapping.enabled !== false
    }))
    .filter((mapping) => mapping.sourceModel && mapping.targetModel)
```

Extend `form` initial state with:

```javascript
  endpointUrl: props.account?.endpointUrl || '',
  modelMappings: props.account?.modelMappings?.length
    ? props.account.modelMappings.map((mapping) => ({ ...mapping }))
    : defaultBridgeMappings(),
```

Extend `errors` with:

```javascript
  endpointUrl: '',
  modelMappings: '',
```

- [ ] **Step 3: Add bridge validation and submit payload in `AccountForm.vue`**

In validation:

```javascript
  if (form.value.platform === 'claude-openai-bridge') {
    if (!form.value.endpointUrl || form.value.endpointUrl.trim() === '') {
      errors.value.endpointUrl = '请填写 Endpoint URL'
    }
    if (!isEdit.value && (!form.value.apiKey || form.value.apiKey.trim() === '')) {
      errors.value.apiKey = '请填写 API Key'
    }
    if (cleanBridgeMappings().length === 0) {
      errors.value.modelMappings = '请至少配置一个模型映射'
    }
  }
```

In create payload branch:

```javascript
    } else if (form.value.platform === 'claude-openai-bridge') {
      data.endpointUrl = form.value.endpointUrl
      data.apiKey = form.value.apiKey
      data.modelMappings = cleanBridgeMappings()
      data.rateLimitDuration = form.value.rateLimitDuration || 60
      data.dailyQuota = form.value.dailyQuota || 0
      data.priority = form.value.priority || 50
```

In edit payload branch:

```javascript
    if (props.account.platform === 'claude-openai-bridge') {
      data.endpointUrl = form.value.endpointUrl
      if (form.value.apiKey && form.value.apiKey.trim()) data.apiKey = form.value.apiKey
      data.modelMappings = cleanBridgeMappings()
      data.rateLimitDuration = form.value.rateLimitDuration || 60
      data.dailyQuota = form.value.dailyQuota || 0
      data.priority = form.value.priority || 50
    }
```

In create/update dispatch:

```javascript
    } else if (form.value.platform === 'claude-openai-bridge') {
      result = await accountsStore.createClaudeOpenAIBridgeAccount(data)
```

and:

```javascript
    } else if (props.account.platform === 'claude-openai-bridge') {
      result = await accountsStore.updateClaudeOpenAIBridgeAccount(props.account.id, data)
```

Update platform group watcher to keep bridge under the Claude group:

```javascript
if (newPlatform === 'claude-openai-bridge' && form.value.modelMappings.length === 0) {
  form.value.modelMappings = defaultBridgeMappings()
}
```

- [ ] **Step 4: Add bridge account list integration to `AccountsView.vue`**

Add bridge platform labels and filters:

```javascript
  'claude-openai-bridge': ['claude-openai-bridge'],
```

Add platform option under Claude group:

```javascript
{ value: 'claude-openai-bridge', label: 'Claude OpenAI Bridge', icon: 'fa-exchange-alt' }
```

Add account fetcher:

```javascript
  'claude-openai-bridge': () => httpApis.getClaudeOpenAIBridgeAccountsApi(),
```

Add account aggregation case near Claude platforms:

```javascript
        case 'claude-openai-bridge': {
          const items = (data || []).map((acc) => ({
            ...acc,
            platform: 'claude-openai-bridge',
            boundApiKeysCount: acc.boundApiKeysCount || 0
          }))
          allAccounts.push(...items)
          break
        }
```

Add reset/toggle/test endpoint mappings:

```javascript
  'claude-openai-bridge': (id) => `/admin/claude-openai-bridge/accounts/${id}/reset-status`,
```

```javascript
  'claude-openai-bridge': (id) => `/admin/claude-openai-bridge/accounts/${id}/toggle-schedulable`,
```

In `getAccountEndpoint(account)`:

```javascript
    case 'claude-openai-bridge':
      return `/admin/claude-openai-bridge/accounts/${account.id}`
```

In account test endpoint resolution:

```javascript
      case 'claude-openai-bridge':
        endpoint = `/admin/claude-openai-bridge/accounts/${accountId}/test`
        break
```

Add row display for endpoint/mapping count in the platform-specific detail area:

```vue
<div v-else-if="account.platform === 'claude-openai-bridge'" class="text-xs text-gray-500">
  <div>{{ account.endpointUrl }}</div>
  <div>{{ account.mappingCount || account.modelMappings?.length || 0 }} 个模型映射</div>
</div>
```

Add a compact global switch near the top toolbar:

```vue
<button
  class="flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm font-medium text-gray-700 shadow-sm transition-all duration-200 hover:border-gray-300 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-300"
  @click="toggleClaudeOpenAIBridge"
>
  <i :class="claudeOpenAIBridgeConfig.enabled ? 'fas fa-toggle-on text-green-500' : 'fas fa-toggle-off text-gray-400'" />
  <span>Bridge {{ claudeOpenAIBridgeConfig.enabled ? '已启用' : '已关闭' }}</span>
</button>
```

Add script state:

```javascript
const claudeOpenAIBridgeConfig = computed(() => accountsStore.claudeOpenAIBridgeConfig)
const toggleClaudeOpenAIBridge = async () => {
  await accountsStore.updateClaudeOpenAIBridgeConfig({
    enabled: !claudeOpenAIBridgeConfig.value.enabled
  })
}
```

- [ ] **Step 5: Build frontend to verify UI changes**

Run: `npm run build:web`

Expected: PASS.

- [ ] **Step 6: Commit admin UI**

```bash
git add web/admin-spa/src/views/AccountsView.vue web/admin-spa/src/components/accounts/AccountForm.vue
git commit -m "feat: add Claude OpenAI bridge admin UI"
```

## Task 8: End-To-End Verification

**Files:**
- No new files.

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
npm test -- \
  tests/claudeOpenAIBridgeAccountService.test.js \
  tests/claudeOpenAIBridgeConverter.test.js \
  tests/claudeOpenAIBridgeRelayService.test.js \
  tests/api.claudeOpenAIBridgeRouting.test.js \
  tests/admin.claudeOpenAIBridgeAccounts.test.js
```

Expected: PASS.

- [ ] **Step 2: Run existing related backend tests**

Run:

```bash
npm test -- \
  tests/api.vertexNonStreamPartialUsage.test.js \
  tests/openaiResponsesRelayService.passThrough.test.js \
  tests/openaiRoutes.passThrough.test.js
```

Expected: PASS.

- [ ] **Step 3: Run frontend build verification**

Run:

```bash
npm run install:web && npm run build:web
```

Expected: PASS.

- [ ] **Step 4: Run lint check**

Run: `npm run lint:check`

Expected: PASS.

- [ ] **Step 5: Review final diff**

Run:

```bash
git status --short
git diff --stat HEAD
```

Expected: only intended bridge implementation files are modified.
