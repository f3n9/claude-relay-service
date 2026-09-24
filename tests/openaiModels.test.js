const express = require('express')
const request = require('supertest')
const crypto = require('crypto')

jest.mock('axios', () => ({ get: jest.fn() }))
jest.mock('../config/config', () => ({ requestTimeout: 1000 }))
jest.mock('../src/middleware/auth', () => ({ authenticateApiKey: jest.fn() }))
jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn()
}))
jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  isTokenExpired: jest.fn(),
  refreshAccountToken: jest.fn(),
  decrypt: jest.fn()
}))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))
jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({ hasPermission: jest.fn() }))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/proxyHelper', () => ({ createProxyAgent: jest.fn() }))
jest.mock('../src/utils/rateLimitHelper', () => ({}))
jest.mock('../src/services/requestBodyRuleService', () => ({}))
jest.mock('../src/routes/azureOpenaiRoutes', () => ({ handleEmbeddingsRequest: jest.fn() }))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  security: jest.fn()
}))

const axios = require('axios')
const { authenticateApiKey } = require('../src/middleware/auth')
const scheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const oauthAccounts = require('../src/services/account/openaiAccountService')
const apiAccounts = require('../src/services/account/openaiResponsesAccountService')
const apiKeys = require('../src/services/apiKeyService')
const proxyHelper = require('../src/utils/proxyHelper')
const router = require('../src/routes/openaiRoutes')
const app = express()
app.use('/openai', router)
let key

beforeEach(() => {
  jest.resetAllMocks()
  key = { id: 'key-1', permissions: ['openai'], openaiAccountId: 'oauth-1' }
  authenticateApiKey.mockImplementation((req, res, next) => {
    if (req.headers.authorization !== 'Bearer relay-secret') {
      return res.status(401).json({ error: 'Invalid API key' })
    }
    req.apiKey = key
    next()
  })
  apiKeys.hasPermission.mockReturnValue(true)
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'oauth-1',
    accountType: 'openai'
  })
  oauthAccounts.getAccount.mockResolvedValue({
    id: 'oauth-1',
    accessToken: 'encrypted',
    accountId: 'chatgpt-1'
  })
  oauthAccounts.decrypt.mockReturnValue('oauth-token')
  axios.get.mockResolvedValue({ status: 200, data: { models: [] } })
})

const getModels = (path = '/openai/models') =>
  request(app).get(path).set('Authorization', 'Bearer relay-secret')

test.each(['/openai/models', '/openai/v1/models'])(
  '%s relays the Codex catalog with client version and trusted account credentials',
  async (path) => {
    const model = {
      slug: 'gpt-example',
      display_name: 'Example',
      context_window: 123456,
      default_reasoning_level: 'high',
      supported_reasoning_levels: [{ effort: 'high', description: 'High' }],
      model_messages: { instructions_template: 'upstream instructions' }
    }
    axios.get.mockResolvedValue({ status: 200, data: { models: [model], extra: 'preserved' } })
    const res = await getModels(`${path}?api-version=2025-04-01-preview&client_version=0.153.4`)
      .set('session_id', 'session-1')
      .set('User-Agent', 'codex_cli_rs/0.153.4')
      .set('chatgpt-account-id', 'attacker-account')
      .set('x-api-key', 'relay-secret')
      .set('Cookie', 'private-cookie')
    expect(res.status).toBe(200)
    expect(res.body.models).toEqual([model])
    expect(res.body.extra).toBe('preserved')
    expect(res.body.data).toEqual([
      { id: 'gpt-example', object: 'model', created: 0, owned_by: 'openai' }
    ])
    const [url, options] = axios.get.mock.calls[0]
    expect(url).toBe('https://chatgpt.com/backend-api/codex/models?client_version=0.153.4')
    expect(options.headers).toMatchObject({
      authorization: 'Bearer oauth-token',
      'chatgpt-account-id': 'chatgpt-1',
      'user-agent': 'codex_cli_rs/0.153.4'
    })
    expect(options.headers.cookie).toBeUndefined()
    expect(options.headers['x-api-key']).toBeUndefined()
    expect(options.maxRedirects).toBe(0)
    expect(scheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      key,
      crypto.createHash('sha256').update('session-1').digest('hex'),
      null
    )
    expect(res.headers['cache-control']).toBe('private, no-store')
  }
)

test.each([
  ['https://provider.test/openai', '/openai/models', '/openai/models'],
  ['https://provider.test/v1/', '/openai/v1/models', '/v1/models'],
  ['https://provider.test', '/openai/v1/models', '/v1/models'],
  ['https://api.openai.com', '/openai/models', '/v1/models']
])('API account base %s uses the matching models endpoint', async (baseApi, path, upstreamPath) => {
  key.openaiAccountId = 'responses:api-1'
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'api-1',
    accountType: 'openai-responses'
  })
  apiAccounts.getAccount.mockResolvedValue({
    id: 'api-1',
    apiKey: 'provider-secret',
    baseApi,
    apiVersion: 'configured-version'
  })
  const data = [{ id: 'provider-model', object: 'model', owned_by: 'provider', created: 42 }]
  axios.get.mockResolvedValue({ status: 200, data: { object: 'list', data } })
  const res = await getModels(`${path}?client_version=0.153.4&api-version=client-version`)
  expect(res.status).toBe(200)
  expect(res.body.data).toEqual(data)
  expect(res.body.models).toEqual([
    expect.objectContaining({
      slug: 'provider-model',
      display_name: 'provider-model',
      visibility: 'list'
    })
  ])
  const [url, options] = axios.get.mock.calls[0]
  const target = new URL(url)
  expect(target.pathname).toBe(upstreamPath)
  expect(target.searchParams.get('api-version')).toBe(
    target.hostname === 'api.openai.com' ? null : 'configured-version'
  )
  expect(target.searchParams.get('client_version')).toBe('0.153.4')
  expect(options.headers.authorization).toBe('Bearer provider-secret')
  expect(options.headers['chatgpt-account-id']).toBeUndefined()
})

test('filters both formats using the key denylist and OAuth account supported models', async () => {
  key.enableModelRestriction = true
  key.restrictedModels = ['blocked']
  oauthAccounts.getAccount.mockResolvedValue({
    id: 'oauth-1',
    accessToken: 'encrypted',
    supportedModels: ['allowed', 'blocked']
  })
  axios.get.mockResolvedValue({
    status: 200,
    data: {
      models: ['allowed', 'blocked', 'unsupported'].map((slug) => ({ slug })),
      data: ['allowed', 'blocked', 'unsupported'].map((id) => ({ id }))
    }
  })
  const res = await getModels()
  expect(res.status).toBe(200)
  expect(res.body.models).toEqual([expect.objectContaining({ slug: 'allowed' })])
  expect(res.body.data).toEqual([{ id: 'allowed' }])
})

test.each(['group:group-1', undefined])(
  'delegates binding %s to the existing scheduler',
  async (binding) => {
    key.openaiAccountId = binding
    const res = await getModels()
    expect(res.status).toBe(200)
    expect(scheduler.selectAccountForApiKey).toHaveBeenCalledWith(key, null, null)
  }
)

test('refreshes expired OAuth tokens and uses the account proxy', async () => {
  oauthAccounts.getAccount
    .mockResolvedValueOnce({ accessToken: 'old', refreshToken: 'refresh' })
    .mockResolvedValueOnce({ accessToken: 'new', proxy: '{"type":"http","host":"proxy.test"}' })
  oauthAccounts.isTokenExpired.mockReturnValue(true)
  const agent = {}
  proxyHelper.createProxyAgent.mockReturnValue(agent)
  const res = await getModels()
  expect(res.status).toBe(200)
  expect(oauthAccounts.refreshAccountToken).toHaveBeenCalledWith('oauth-1')
  expect(oauthAccounts.decrypt).toHaveBeenCalledWith('new')
  expect(axios.get.mock.calls[0][1]).toMatchObject({
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false
  })
})

test('requires authentication and OpenAI permission before selecting an account', async () => {
  expect((await request(app).get('/openai/models')).status).toBe(401)
  apiKeys.hasPermission.mockReturnValue(false)
  expect((await getModels()).status).toBe(403)
  expect(scheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  expect(axios.get).not.toHaveBeenCalled()
})

test('returns the scheduler failure without attempting an unrelated account', async () => {
  scheduler.selectAccountForApiKey.mockRejectedValue(
    Object.assign(new Error('Unavailable'), { statusCode: 402 })
  )
  expect((await getModels()).status).toBe(402)
  expect(axios.get).not.toHaveBeenCalled()
})

test.each([401, 403, 404, 429, 500])(
  'upstream %s never becomes a fabricated model list',
  async (status) => {
    axios.get.mockResolvedValue({ status, data: { error: 'provider-secret' } })
    const res = await getModels()
    expect(res.status).toBe(status)
    expect(res.body.models).toBeUndefined()
    expect(JSON.stringify(res.body)).not.toContain('provider-secret')
  }
)

test.each([null, '<html>login</html>', {}, { data: [{ name: 'bad' }] }])(
  'rejects invalid upstream catalog %j',
  async (data) => {
    axios.get.mockResolvedValue({ status: 200, data })
    expect((await getModels()).status).toBe(502)
  }
)

test('network timeout returns 504 without exposing credentials', async () => {
  axios.get.mockRejectedValue(Object.assign(new Error('provider-secret'), { code: 'ECONNABORTED' }))
  const res = await getModels()
  expect(res.status).toBe(504)
  expect(JSON.stringify(res.body)).not.toContain('provider-secret')
})

test('real HTTP forwards discovery to the API account and does not relay client secrets', async () => {
  const upstream = express()
  const received = []
  upstream.get('/openai/models', (req, res) => {
    received.push({ headers: req.headers, query: req.query })
    res.json({ models: [{ slug: 'deployment-1', context_window: 500000 }] })
  })
  const server = upstream.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    key.openaiAccountId = 'responses:api-1'
    scheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'api-1',
      accountType: 'openai-responses'
    })
    apiAccounts.getAccount.mockResolvedValue({
      id: 'api-1',
      apiKey: 'provider-secret',
      baseApi: `http://127.0.0.1:${server.address().port}/openai`,
      apiVersion: '2025-04-01-preview'
    })
    axios.get.mockImplementation(jest.requireActual('axios').get)
    const res = await getModels('/openai/models?client_version=0.153.4&api_key=relay-secret')
      .set('Cookie', 'private-cookie')
      .set('x-api-key', 'relay-secret')
    expect(res.status).toBe(200)
    expect(res.body.models).toEqual([
      expect.objectContaining({ slug: 'deployment-1', context_window: 500000 })
    ])
    expect(received).toHaveLength(1)
    expect(received[0].query).toEqual({
      'api-version': '2025-04-01-preview',
      client_version: '0.153.4'
    })
    expect(received[0].headers.authorization).toBe('Bearer provider-secret')
    expect(received[0].headers.cookie).toBeUndefined()
    expect(received[0].headers['x-api-key']).toBeUndefined()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('redirects are rejected without sending credentials to a second endpoint', async () => {
  const upstream = express()
  const redirected = jest.fn((req, res) => res.json({ models: [] }))
  upstream.get('/models', (req, res) => res.redirect('/redirected'))
  upstream.get('/redirected', redirected)
  const server = upstream.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    scheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'api-1',
      accountType: 'openai-responses'
    })
    apiAccounts.getAccount.mockResolvedValue({
      id: 'api-1',
      apiKey: 'provider-secret',
      baseApi: `http://127.0.0.1:${server.address().port}`
    })
    axios.get.mockImplementation(jest.requireActual('axios').get)
    expect((await getModels()).status).toBe(502)
    expect(redirected).not.toHaveBeenCalled()
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test.each(['openai', 'openai-responses'])(
  '%s account can disable model listing on both aliases without upstream discovery',
  async (accountType) => {
    scheduler.selectAccountForApiKey.mockResolvedValue({ accountId: 'account-1', accountType })
    const account = {
      id: 'account-1',
      accessToken: 'encrypted',
      apiKey: 'provider-secret',
      baseApi: 'https://provider.test/v1',
      modelDiscoveryPatterns: ['gpt-5'],
      disableModelListing: 'true'
    }
    oauthAccounts.getAccount.mockResolvedValue(account)
    apiAccounts.getAccount.mockResolvedValue(account)

    for (const path of ['/openai/models', '/openai/v1/models']) {
      const res = await getModels(path)
      expect(res.status).toBe(404)
      expect(res.body.data).toBeUndefined()
      expect(res.headers['cache-control']).toBe('private, no-store')
    }
    expect(axios.get).not.toHaveBeenCalled()
    expect(oauthAccounts.refreshAccountToken).not.toHaveBeenCalled()
    expect(oauthAccounts.decrypt).not.toHaveBeenCalled()
  }
)

test.each(['openai', 'openai-responses'])(
  'applies %s account discovery allowlist to both response formats',
  async (accountType) => {
    scheduler.selectAccountForApiKey.mockResolvedValue({ accountId: 'account-1', accountType })
    const account = {
      id: 'account-1',
      accessToken: 'encrypted',
      apiKey: 'provider-secret',
      baseApi: 'https://provider.test/v1',
      modelDiscoveryPatterns: ['gpt-5', 'gpt-5.6-*']
    }
    oauthAccounts.getAccount.mockResolvedValue(account)
    apiAccounts.getAccount.mockResolvedValue(account)
    axios.get.mockResolvedValue({
      status: 200,
      data: { models: ['gpt-5', 'gpt-5.1', 'gpt-5.6-mini', 'gpt-4o'].map((slug) => ({ slug })) }
    })
    for (const path of ['/openai/models', '/openai/v1/models']) {
      const res = await getModels(path)
      expect(res.status).toBe(200)
      expect(res.body.models.map((model) => model.slug)).toEqual(['gpt-5', 'gpt-5.6-mini'])
      expect(res.body.data.map((model) => model.id)).toEqual(['gpt-5', 'gpt-5.6-mini'])
    }
  }
)

test('supplements Azure standard models with reasoning options on both aliases', async () => {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'api-1',
    accountType: 'openai-responses'
  })
  apiAccounts.getAccount.mockResolvedValue({
    id: 'api-1',
    apiKey: 'provider-secret',
    baseApi: 'https://provider.services.ai.azure.com/openai/v1'
  })
  const data = [
    { id: 'gpt-5.6-sol', object: 'model' },
    { id: 'custom-deployment', object: 'model' }
  ]
  axios.get.mockResolvedValue({ status: 200, data: { object: 'list', data } })
  for (const path of ['/openai/models', '/openai/v1/models']) {
    const res = await getModels(path)
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual(data)
    expect(res.body.models[0].supported_reasoning_levels.map((level) => level.effort)).toEqual([
      'none',
      'low',
      'medium',
      'high',
      'xhigh',
      'max'
    ])
    expect(res.body.models[0].default_reasoning_level).toBe('medium')
    expect(res.body.models[1].supported_reasoning_levels.map((level) => level.effort)).toEqual([
      'medium'
    ])
  }
})

test.each(['data', 'models'])(
  'both discovery aliases supplement new models in %s catalogs only when allowed',
  async (format) => {
    const ids = ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.6-sol']
    const entries = ids.map((id) => ({ [format === 'data' ? 'id' : 'slug']: id }))
    axios.get.mockResolvedValue({ status: 200, data: { [format]: entries } })
    const account = {
      id: 'account-1',
      accessToken: 'encrypted',
      apiKey: 'provider-secret',
      baseApi: 'https://provider.test/v1',
      modelDiscoveryPatterns: ['gpt-6-*']
    }
    scheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'account-1',
      accountType: format === 'data' ? 'openai-responses' : 'openai'
    })
    oauthAccounts.getAccount.mockResolvedValue(account)
    apiAccounts.getAccount.mockResolvedValue(account)
    for (const path of ['/openai/models', '/openai/v1/models']) {
      const res = await getModels(path)
      expect(res.status).toBe(200)
      expect(res.body.models.map((model) => model.slug)).toEqual(ids.slice(0, 2))
      expect(res.body.data.map((model) => model.id)).toEqual(ids.slice(0, 2))
      if (format === 'data') {
        expect(res.body.data).toEqual(entries.slice(0, 2))
      }
      for (const model of res.body.models) {
        expect(model.input_modalities).toEqual(['text', 'image'])
        expect(model.output_modalities).toEqual(['text'])
        expect(model.default_reasoning_level).toBe('medium')
        expect(model.supported_reasoning_levels.map((level) => level.effort)).toEqual([
          'none',
          'low',
          'medium',
          'high',
          'xhigh',
          'max'
        ])
      }
      key.enableModelRestriction = true
      key.restrictedModels = ['gpt-6-luna']
      expect((await getModels(path)).body.models.map((model) => model.slug)).toEqual(['gpt-6-sol'])
      key.enableModelRestriction = false
      account.modelDiscoveryPatterns = ['gpt-5.6-*']
      expect((await getModels(path)).body.models.map((model) => model.slug)).toEqual([
        'gpt-5.6-sol'
      ])
      account.modelDiscoveryPatterns = ['gpt-6-*']
    }
    axios.get.mockResolvedValue({ status: 200, data: { [format]: [] } })
    expect((await getModels()).body.models).toEqual([])
  }
)

test('real HTTP preserves Azure input capabilities through both discovery aliases', async () => {
  const upstream = express()
  const data = [
    { id: 'gpt-5.6-sol', object: 'model' },
    { id: 'gpt-audio', object: 'model' },
    { id: 'private-audio-deployment', object: 'model', input_modalities: ['text', 'audio'] },
    { id: 'gpt-4o', object: 'model', input_modalities: ['text'] },
    { id: 'text-embedding-3-small', object: 'model' }
  ]
  upstream.get('/openai/v1/models', (_req, res) => res.json({ object: 'list', data }))
  const server = upstream.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    scheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'api-1',
      accountType: 'openai-responses'
    })
    apiAccounts.getAccount.mockResolvedValue({
      id: 'api-1',
      apiKey: 'provider-secret',
      baseApi: `http://127.0.0.1:${server.address().port}/openai/v1`
    })
    axios.get.mockImplementation(jest.requireActual('axios').get)
    for (const path of ['/openai/models', '/openai/v1/models']) {
      const res = await getModels(path)
      expect(res.status).toBe(200)
      expect(res.body.data).toEqual(data)
      expect(res.body.models.map((model) => [model.slug, model.input_modalities])).toEqual([
        ['gpt-5.6-sol', ['text', 'image']],
        ['gpt-audio', ['text', 'audio']],
        ['private-audio-deployment', ['text', 'audio']],
        ['gpt-4o', ['text']],
        ['text-embedding-3-small', ['text']]
      ])
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
