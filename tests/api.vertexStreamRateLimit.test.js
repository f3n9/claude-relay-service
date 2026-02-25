jest.mock('../src/services/relay/gcpVertexRelayService', () => ({
  relayStreamRequestWithUsageCapture: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn()
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
  parseVendorPrefixedModel: jest.fn((model) => ({ model, vendor: null }))
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
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const apiKeyService = require('../src/services/apiKeyService')
const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')

describe('API /v1/messages Vertex streaming rate limit costs', () => {
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

  it('passes recordUsageWithDetails costs into updateRateLimitCounters for claude-vertex streaming', async () => {
    apiKeyService.hasPermission.mockReturnValue(true)
    unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'vertex-account-1',
      accountType: 'claude-vertex'
    })

    const costs = { realCost: 1.23, ratedCost: 4.56 }
    apiKeyService.recordUsageWithDetails.mockResolvedValue(costs)
    updateRateLimitCounters.mockResolvedValue({ totalTokens: 0, totalCost: 0, ratedCost: 0 })

    gcpVertexRelayService.relayStreamRequestWithUsageCapture.mockImplementation(
      async (_body, _apiKey, _res, _headers, usageCallback) => {
        usageCallback({
          input_tokens: 100,
          output_tokens: 50,
          cache_creation: { ephemeral_1h_input_tokens: 10 },
          cache_read_input_tokens: 5,
          model: 'claude-opus-4-6'
        })
      }
    )

    const handler = getMessagesHandler()
    const req = {
      body: {
        stream: true,
        model: 'claude-opus-4-6',
        messages: [{ role: 'user', content: 'hi' }],
        speed: 'fast'
      },
      headers: {
        'anthropic-beta': 'fast-mode-2026-02-01'
      },
      apiKey: { id: 'key-1', permissions: [], enableModelRestriction: false },
      rateLimitInfo: { tokenCountKey: 't', costCountKey: 'c' }
    }
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis(),
      setHeader: jest.fn(),
      getHeader: jest.fn(),
      headersSent: false,
      destroyed: false,
      finished: false,
      write: jest.fn(),
      end: jest.fn()
    }

    await handler(req, res)
    await new Promise((resolve) => setImmediate(resolve))

    expect(res.status).not.toHaveBeenCalled()
    expect(unifiedClaudeScheduler.selectAccountForApiKey).toHaveBeenCalled()
    expect(gcpVertexRelayService.relayStreamRequestWithUsageCapture).toHaveBeenCalled()
    expect(apiKeyService.recordUsageWithDetails).toHaveBeenCalled()
    expect(updateRateLimitCounters).toHaveBeenCalled()
    expect(updateRateLimitCounters.mock.calls[0][5]).toEqual(costs)
  })
})
