const { EventEmitter } = require('events')

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn(),
  api: jest.fn()
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateApiKey: (_req, _res, next) => next()
}))

jest.mock('../src/services/relay/claudeRelayService', () => ({
  relayStreamRequestWithUsageCapture: jest.fn(),
  relayRequest: jest.fn()
}))

jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({
  relayStreamRequestWithUsageCapture: jest.fn(),
  relayRequest: jest.fn()
}))

jest.mock('../src/services/relay/gcpVertexRelayService', () => ({
  relayStreamRequestWithUsageCapture: jest.fn(),
  relayRequest: jest.fn()
}))

jest.mock('../src/services/openaiToClaude', () => ({
  convertRequest: jest.fn(),
  convertStreamChunk: jest.fn((chunk) => chunk),
  convertResponse: jest.fn((data) => data)
}))

jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(),
  recordUsageWithDetails: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn()
}))

jest.mock('../src/services/account/gcpVertexAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/claudeCodeHeadersService', () => ({
  getAccountHeaders: jest.fn()
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((err) => err?.message || 'error')
}))

jest.mock('../src/utils/sessionHelper', () => ({
  generateSessionHash: jest.fn(() => 'session-hash')
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/services/pricingService', () => ({
  getModelPricing: jest.fn(() => ({}))
}))

jest.mock('../src/utils/modelHelper', () => ({
  getEffectiveModel: jest.fn((model) => model)
}))

const { handleChatCompletion } = require('../src/routes/openaiClaudeRoutes')
const gcpVertexRelayService = require('../src/services/relay/gcpVertexRelayService')
const openaiToClaude = require('../src/services/openaiToClaude')
const apiKeyService = require('../src/services/apiKeyService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const gcpVertexAccountService = require('../src/services/account/gcpVertexAccountService')
const claudeCodeHeadersService = require('../src/services/claudeCodeHeadersService')
const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')

function createMockResponse() {
  const res = {}
  res.headers = {}
  res.headersSent = false
  res.destroyed = false
  res.finished = false
  res.setHeader = jest.fn((key, value) => {
    res.headers[key] = value
  })
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  res.write = jest.fn()
  res.end = jest.fn(() => {
    res.finished = true
  })
  return res
}

describe('openaiClaudeRoutes vertex partial usage', () => {
  beforeEach(() => {
    jest.clearAllMocks()

    apiKeyService.hasPermission.mockReturnValue(true)
    apiKeyService.recordUsageWithDetails.mockResolvedValue({ realCost: 0.11, ratedCost: 0.22 })

    openaiToClaude.convertRequest.mockReturnValue({
      stream: true,
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hi' }]
    })

    unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'vertex-acc-1',
      accountType: 'claude-vertex'
    })
    gcpVertexAccountService.getAccount.mockResolvedValue({
      id: 'vertex-acc-1',
      location: 'asia-east1'
    })

    claudeCodeHeadersService.getAccountHeaders.mockResolvedValue({
      'user-agent': 'test-agent'
    })

    updateRateLimitCounters.mockResolvedValue({
      totalTokens: 0,
      totalCost: 0,
      ratedCost: 0
    })
  })

  it('records vertex stream partial usage with output_tokens normalized to 0', async () => {
    gcpVertexRelayService.relayStreamRequestWithUsageCapture.mockImplementation(
      async (_claudeReq, _apiKeyData, _res, _headers, usageCallback) => {
        usageCallback({
          input_tokens: 66,
          cache_creation_input_tokens: 4,
          cache_read_input_tokens: 2,
          usage_capture_state: 'partial',
          model: 'claude-opus-4-6'
        })
      }
    )

    const req = new EventEmitter()
    req.body = {
      stream: true,
      model: 'claude-opus-4-6',
      messages: [{ role: 'user', content: 'hello' }]
    }
    req.headers = {
      'anthropic-beta': 'test-beta'
    }
    req.apiKey = {
      id: 'key-openai-vertex-1',
      permissions: ['claude'],
      enableModelRestriction: false
    }
    req.rateLimitInfo = {
      tokenCountKey: 'token-key',
      costCountKey: 'cost-key'
    }

    const res = createMockResponse()

    await handleChatCompletion(req, res, req.apiKey)
    await new Promise((resolve) => setImmediate(resolve))

    expect(apiKeyService.recordUsageWithDetails).toHaveBeenCalledWith(
      'key-openai-vertex-1',
      expect.objectContaining({
        input_tokens: 66,
        output_tokens: 0,
        cache_creation_input_tokens: 4,
        cache_read_input_tokens: 2,
        usage_capture_state: 'partial',
        request_anthropic_beta: 'test-beta',
        request_provider: 'vertex',
        request_region: 'asia-east1'
      }),
      'claude-opus-4-6',
      'vertex-acc-1',
      'claude-vertex'
    )
    expect(updateRateLimitCounters).toHaveBeenCalled()
  })
})
