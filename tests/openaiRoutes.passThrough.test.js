jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: (req, res, next) => next()
}))

jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  markAccountRateLimited: jest.fn(),
  markAccountUnauthorized: jest.fn(),
  isAccountRateLimited: jest.fn(),
  removeAccountRateLimit: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  isTokenExpired: jest.fn(),
  refreshAccountToken: jest.fn(),
  decrypt: jest.fn(),
  updateCodexUsageSnapshot: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(),
  recordUsage: jest.fn()
}))

jest.mock('../src/models/redis', () => ({}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn()
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

jest.mock('../config/config', () => ({
  requestTimeout: 60000
}))

const axios = require('axios')
const unifiedOpenAIScheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesRelayService = require('../src/services/relay/openaiResponsesRelayService')
const apiKeyService = require('../src/services/apiKeyService')
const ProxyHelper = require('../src/utils/proxyHelper')
const { handleResponses, CODEX_CLI_INSTRUCTIONS } = require('../src/routes/openaiRoutes')

function createMockResponse() {
  const res = {}
  res.headersSent = false
  res.destroyed = false
  res.status = jest.fn().mockImplementation(() => res)
  res.setHeader = jest.fn()
  res.json = jest.fn().mockImplementation(() => res)
  res.write = jest.fn()
  res.end = jest.fn()
  res.flushHeaders = jest.fn()
  return res
}

function createBaseRequest() {
  return {
    apiKey: {
      id: 'key-1',
      permissions: ['openai']
    },
    headers: {
      'user-agent': 'integration-client/1.0',
      'openai-beta': 'responses=v1',
      'x-codex-beta-features': 'custom_tool_input',
      session_id: 'session-123'
    },
    body: {
      model: 'gpt-5-2026-01-01',
      stream: false,
      instructions: 'keep-me',
      temperature: 0.8,
      store: true
    },
    path: '/responses',
    originalUrl: '/openai/responses'
  }
}

describe('openaiRoutes handleResponses passThrough behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    apiKeyService.hasPermission.mockReturnValue(true)
    apiKeyService.recordUsage.mockResolvedValue({})

    unifiedOpenAIScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'oa-1',
      accountType: 'openai'
    })
    unifiedOpenAIScheduler.isAccountRateLimited.mockResolvedValue(false)

    openaiAccountService.isTokenExpired.mockReturnValue(false)
    openaiAccountService.decrypt.mockReturnValue('decrypted-openai-token')
    openaiAccountService.updateCodexUsageSnapshot.mockResolvedValue(undefined)

    ProxyHelper.createProxyAgent.mockReturnValue(null)

    axios.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        model: 'gpt-5',
        usage: {
          input_tokens: 10,
          output_tokens: 2,
          input_tokens_details: { cached_tokens: 0 }
        }
      }
    })
  })

  it('keeps legacy adaptation when passThrough is disabled', async () => {
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'oa-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1',
      passThrough: 'false'
    })

    const req = createBaseRequest()
    const res = createMockResponse()

    await handleResponses(req, res)

    expect(axios.post).toHaveBeenCalledTimes(1)
    const [endpoint, body, config] = axios.post.mock.calls[0]

    expect(endpoint).toBe('https://chatgpt.com/backend-api/codex/responses')
    expect(body.model).toBe('gpt-5')
    expect(body.instructions).toBe(CODEX_CLI_INSTRUCTIONS)
    expect(body.temperature).toBeUndefined()
    expect(body.store).toBe(false)
    expect(config.headers['x-codex-beta-features']).toBeUndefined()
    expect(config.headers['openai-beta']).toBe('responses=v1')
    expect(config.headers.authorization).toBe('Bearer decrypted-openai-token')

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5'
      })
    )
    expect(openaiResponsesRelayService.handleRequest).not.toHaveBeenCalled()
  })

  it('preserves headers and payload when passThrough is enabled', async () => {
    openaiAccountService.getAccount.mockResolvedValue({
      id: 'oa-1',
      name: 'OpenAI Account',
      accessToken: 'encrypted-token',
      accountId: 'chatgpt-account-1',
      passThrough: 'true'
    })

    const req = createBaseRequest()
    req.headers.cookie = 'relay_session=secret-cookie'
    req.headers['content-encoding'] = 'gzip'
    req.headers['transfer-encoding'] = 'chunked'
    req.headers.te = 'trailers'
    req.headers.trailer = 'x-checksum'
    const res = createMockResponse()

    await handleResponses(req, res)

    expect(axios.post).toHaveBeenCalledTimes(1)
    const [, body, config] = axios.post.mock.calls[0]

    expect(body.model).toBe('gpt-5')
    expect(body.instructions).toBe('keep-me')
    expect(body.temperature).toBe(0.8)
    expect(body.store).toBe(true)
    expect(config.headers['x-codex-beta-features']).toBe('custom_tool_input')
    expect(config.headers['user-agent']).toBe('integration-client/1.0')
    expect(config.headers.cookie).toBeUndefined()
    expect(config.headers['content-encoding']).toBeUndefined()
    expect(config.headers['transfer-encoding']).toBeUndefined()
    expect(config.headers.te).toBeUndefined()
    expect(config.headers.trailer).toBeUndefined()
    expect(config.headers.authorization).toBe('Bearer decrypted-openai-token')
  })
})
