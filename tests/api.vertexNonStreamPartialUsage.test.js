jest.mock('../src/services/relay/gcpVertexRelayService', () => ({
  relayRequest: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn()
}))

jest.mock('../src/services/account/gcpVertexAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(),
  recordUsageWithDetails: jest.fn()
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: (_req, _res, next) => next()
}))

jest.mock('../src/utils/sessionHelper', () => ({
  generateSessionHash: jest.fn(() => 'test-session-hash')
}))

jest.mock('../src/utils/modelHelper', () => ({
  getEffectiveModel: jest.fn((model) => model),
  parseVendorPrefixedModel: jest.fn((model) => ({ baseModel: model, vendor: null }))
}))

jest.mock('../src/services/claudeRelayConfigService', () => ({
  isGlobalSessionBindingEnabled: jest.fn(async () => false),
  extractOriginalSessionId: jest.fn(() => null),
  validateNewSession: jest.fn(async () => ({ binding: null, isNewSession: false })),
  getSessionBindingErrorMessage: jest.fn(async () => 'session binding error'),
  setOriginalSessionBinding: jest.fn(async () => {}),
  getConfig: jest.fn(async () => ({}))
}))

jest.mock('../src/utils/anthropicRequestDump', () => ({
  dumpAnthropicMessagesRequest: jest.fn()
}))

jest.mock('../src/utils/warmupInterceptor', () => ({
  isWarmupRequest: jest.fn(() => false),
  buildMockWarmupResponse: jest.fn(() => ({})),
  sendMockWarmupStream: jest.fn()
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  sanitizeUpstreamError: jest.fn((error) => error)
}))

jest.mock('../src/services/anthropicGeminiBridgeService', () => ({
  handleAnthropicMessagesToGemini: jest.fn(),
  handleAnthropicCountTokensToGemini: jest.fn()
}))

jest.mock('../src/utils/commonHelper', () => ({
  sortAccountsByPriority: jest.fn((accounts) => accounts)
}))

jest.mock('../src/routes/countTokensBindingHelper', () => ({
  hasExplicitDedicatedClaudeBinding: jest.fn(() => false),
  getCountTokensFallbackGroupId: jest.fn(() => null),
  selectCountTokensCapableFallbackAccount: jest.fn(async () => null),
  selectCountTokensCapableGroupFallbackAccount: jest.fn(async () => null)
}))

jest.mock('../src/services/relay/claudeRelayService', () => ({}))
jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({}))
jest.mock('../src/services/relay/bedrockRelayService', () => ({}))
jest.mock('../src/services/relay/ccrRelayService', () => ({}))
jest.mock('../src/services/account/bedrockAccountService', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

const gcpVertexRelayService = require('../src/services/relay/gcpVertexRelayService')
const gcpVertexAccountService = require('../src/services/account/gcpVertexAccountService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const apiKeyService = require('../src/services/apiKeyService')
const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')
const logger = require('../src/utils/logger')

describe('API /v1/messages Vertex non-stream partial usage', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const getMessagesHandler = () => {
    const router = require('../src/routes/api')
    const routeLayer = router.stack.find(
      (layer) => layer.route && layer.route.path === '/v1/messages' && layer.route.methods.post
    )
    return routeLayer.route.stack[routeLayer.route.stack.length - 1].handle
  }

  it('records partial non-stream vertex usage when output_tokens is missing', async () => {
    apiKeyService.hasPermission.mockReturnValue(true)
    unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'vertex-account-1',
      accountType: 'claude-vertex'
    })
    gcpVertexAccountService.getAccount.mockResolvedValue({
      id: 'vertex-account-1',
      location: 'us-central1'
    })

    const costs = { realCost: 0.21, ratedCost: 0.43 }
    apiKeyService.recordUsageWithDetails.mockResolvedValue(costs)
    updateRateLimitCounters.mockResolvedValue({ totalTokens: 0, totalCost: 0, ratedCost: 0 })

    gcpVertexRelayService.relayRequest.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        usage: {
          input_tokens: 123,
          cache_creation_input_tokens: 9,
          cache_read_input_tokens: 4
        }
      }),
      accountId: 'vertex-account-1'
    })

    const handler = getMessagesHandler()
    const req = {
      body: {
        stream: false,
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hi' }]
      },
      headers: {
        'anthropic-beta': 'vertex-beta-1'
      },
      query: {},
      url: '/v1/messages',
      path: '/v1/messages',
      requestId: 'req-vertex-nonstream-1',
      apiKey: { id: 'key-3', name: 'key-3', permissions: [], enableModelRestriction: false },
      rateLimitInfo: { tokenCountKey: 't3', costCountKey: 'c3' }
    }
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      send: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      headersSent: false,
      destroyed: false,
      finished: false,
      writableEnded: false,
      socket: {
        destroyed: false,
        once: jest.fn(),
        removeListener: jest.fn()
      },
      once: jest.fn()
    }

    await handler(req, res)

    expect(gcpVertexRelayService.relayRequest).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsageWithDetails).toHaveBeenCalledWith(
      'key-3',
      expect.objectContaining({
        input_tokens: 123,
        output_tokens: 0,
        cache_creation_input_tokens: 9,
        cache_read_input_tokens: 4,
        usage_capture_state: 'partial',
        request_anthropic_beta: 'vertex-beta-1'
      }),
      'claude-opus-4-6',
      'vertex-account-1',
      'claude-vertex'
    )
    expect(updateRateLimitCounters).toHaveBeenCalled()
    expect(updateRateLimitCounters.mock.calls[0][5]).toEqual(costs)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Vertex non-stream usage missing output_tokens')
    )
    expect(logger.info).toHaveBeenCalledWith(
      '📊 Vertex usage reconciliation',
      expect.objectContaining({
        mode: 'non-stream',
        accountId: 'vertex-account-1',
        model: 'claude-opus-4-6',
        request_region: 'us-central1',
        requestId: 'req-vertex-nonstream-1',
        usage_capture_state: 'partial',
        input_tokens: 123,
        output_tokens: 0,
        cache_creation_input_tokens: 9,
        cache_read_input_tokens: 4,
        total_tokens: 136
      })
    )
  })
})
