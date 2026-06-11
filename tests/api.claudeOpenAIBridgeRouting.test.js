jest.mock('../src/services/account/claudeOpenAIBridgeAccountService', () => ({
  selectAccountForModel: jest.fn()
}))

jest.mock('../src/services/relay/claudeOpenAIBridgeRelayService', () => ({
  handleRequest: jest.fn()
}))

jest.mock('../src/services/relay/gcpVertexRelayService', () => ({
  relayRequest: jest.fn()
}))

jest.mock('../src/services/scheduler/unifiedClaudeScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  clearSessionMapping: jest.fn()
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

jest.mock('../src/services/relay/claudeRelayService', () => ({
  _buildStandardRateLimitMessage: jest.fn(() => 'rate limited')
}))
jest.mock('../src/services/relay/claudeConsoleRelayService', () => ({}))
jest.mock('../src/services/relay/bedrockRelayService', () => ({}))
jest.mock('../src/services/relay/ccrRelayService', () => ({}))
jest.mock('../src/services/account/bedrockAccountService', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({}))
jest.mock('../src/services/account/gcpVertexAccountService', () => ({
  getAccount: jest.fn(async () => ({ id: 'vertex-account-1', location: 'global' }))
}))

jest.mock('../src/utils/logger', () => ({
  api: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

const bridgeAccountService = require('../src/services/account/claudeOpenAIBridgeAccountService')
const bridgeRelayService = require('../src/services/relay/claudeOpenAIBridgeRelayService')
const gcpVertexRelayService = require('../src/services/relay/gcpVertexRelayService')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')
const apiKeyService = require('../src/services/apiKeyService')
const { handleAnthropicMessagesToGemini } = require('../src/services/anthropicGeminiBridgeService')

function getMessagesHandler() {
  const router = require('../src/routes/api')
  const routeLayer = router.stack.find(
    (layer) => layer.route && layer.route.path === '/v1/messages' && layer.route.methods.post
  )
  return routeLayer.route.stack[routeLayer.route.stack.length - 1].handle
}

function createReq(overrides = {}) {
  return {
    body: {
      stream: false,
      model: 'claude-sonnet-4-bridge',
      messages: [{ role: 'user', content: 'hi' }]
    },
    headers: {},
    query: {},
    url: '/v1/messages',
    path: '/v1/messages',
    requestId: 'req-bridge-route-1',
    apiKey: {
      id: 'key-1',
      name: 'test-key',
      permissions: [],
      enableModelRestriction: false
    },
    rateLimitInfo: { tokenCountKey: 'tokens', costCountKey: 'costs' },
    ...overrides
  }
}

function createRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    setHeader: jest.fn(),
    getHeader: jest.fn(),
    headersSent: false,
    destroyed: false,
    finished: false,
    writableEnded: false,
    socket: {
      destroyed: false,
      once: jest.fn(),
      removeListener: jest.fn()
    },
    once: jest.fn(),
    end: jest.fn()
  }
}

describe('API /v1/messages Claude OpenAI bridge routing', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.hasPermission.mockReturnValue(true)
    bridgeAccountService.selectAccountForModel.mockResolvedValue(null)
    bridgeRelayService.handleRequest.mockResolvedValue(undefined)
    unifiedClaudeScheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'vertex-account-1',
      accountType: 'claude-vertex'
    })
    gcpVertexRelayService.relayRequest.mockResolvedValue({
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'msg-1', model: 'claude-sonnet-4-bridge' }),
      accountId: 'vertex-account-1'
    })
    handleAnthropicMessagesToGemini.mockResolvedValue(undefined)
  })

  it('routes matching source models to the Claude OpenAI bridge without normal Claude scheduling', async () => {
    const selection = {
      account: {
        id: 'bridge-account-1',
        name: 'Bridge Account'
      },
      mapping: {
        sourceModel: 'claude-sonnet-4-bridge',
        targetModel: 'gpt-4.1-mini'
      }
    }
    bridgeAccountService.selectAccountForModel.mockResolvedValue(selection)

    const req = createReq({
      body: {
        stream: true,
        model: 'claude-sonnet-4-bridge',
        messages: [{ role: 'user', content: 'hi' }]
      }
    })
    const res = createRes()

    await getMessagesHandler()(req, res)

    expect(bridgeAccountService.selectAccountForModel).toHaveBeenCalledWith(
      'claude-sonnet-4-bridge',
      { boundAccountId: '' }
    )
    expect(bridgeRelayService.handleRequest).toHaveBeenCalledWith(req, res, selection)
    expect(unifiedClaudeScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
    expect(gcpVertexRelayService.relayRequest).not.toHaveBeenCalled()
  })

  it('falls through to normal Claude scheduling when no bridge mapping matches', async () => {
    const req = createReq()
    const res = createRes()

    await getMessagesHandler()(req, res)

    expect(bridgeAccountService.selectAccountForModel).toHaveBeenCalledWith(
      'claude-sonnet-4-bridge',
      { boundAccountId: '' }
    )
    expect(bridgeRelayService.handleRequest).not.toHaveBeenCalled()
    expect(unifiedClaudeScheduler.selectAccountForApiKey).toHaveBeenCalledWith(
      req.apiKey,
      'test-session-hash',
      'claude-sonnet-4-bridge',
      null
    )
    expect(gcpVertexRelayService.relayRequest).toHaveBeenCalled()
  })

  it('passes API key bridge account binding into bridge account selection', async () => {
    const selection = {
      account: {
        id: 'bridge-account-1',
        name: 'Bridge Account'
      },
      mapping: {
        sourceModel: 'claude-sonnet-4-bridge',
        targetModel: 'gpt-4.1-mini'
      }
    }
    bridgeAccountService.selectAccountForModel.mockResolvedValue(selection)

    const req = createReq({
      apiKey: {
        id: 'key-1',
        name: 'test-key',
        permissions: [],
        enableModelRestriction: false,
        claudeOpenAIBridgeAccountId: 'bridge-account-1'
      }
    })
    const res = createRes()

    await getMessagesHandler()(req, res)

    expect(bridgeAccountService.selectAccountForModel).toHaveBeenCalledWith(
      'claude-sonnet-4-bridge',
      { boundAccountId: 'bridge-account-1' }
    )
    expect(bridgeRelayService.handleRequest).toHaveBeenCalledWith(req, res, selection)
  })

  it('bypasses bridge selection for forced Gemini vendors', async () => {
    const req = createReq({
      _anthropicVendor: 'gemini-cli',
      body: {
        stream: false,
        model: 'gemini-2.5-pro',
        messages: [{ role: 'user', content: 'hi' }]
      }
    })
    const res = createRes()

    await getMessagesHandler()(req, res)

    expect(bridgeAccountService.selectAccountForModel).not.toHaveBeenCalled()
    expect(handleAnthropicMessagesToGemini).toHaveBeenCalledWith(req, res, {
      vendor: 'gemini-cli',
      baseModel: 'gemini-2.5-pro'
    })
    expect(unifiedClaudeScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  })

  it.each([
    [
      'empty messages',
      {
        body: {
          stream: false,
          model: 'claude-sonnet-4-bridge',
          messages: []
        },
        expectedStatus: 400
      }
    ],
    [
      'restricted model',
      {
        apiKey: {
          id: 'key-1',
          name: 'test-key',
          permissions: [],
          enableModelRestriction: true,
          restrictedModels: ['claude-sonnet-4-bridge']
        },
        expectedStatus: 403
      }
    ]
  ])('runs %s checks before bridge selection', async (_name, overrides) => {
    const req = createReq(overrides)
    const res = createRes()

    await getMessagesHandler()(req, res)

    expect(res.status).toHaveBeenCalledWith(overrides.expectedStatus)
    expect(bridgeAccountService.selectAccountForModel).not.toHaveBeenCalled()
    expect(bridgeRelayService.handleRequest).not.toHaveBeenCalled()
    expect(unifiedClaudeScheduler.selectAccountForApiKey).not.toHaveBeenCalled()
  })
})
