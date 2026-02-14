jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/ccrAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/geminiAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/geminiApiAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/droidAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/gcpVertexAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/bedrockAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({}))

jest.mock('../src/models/redis', () => ({
  getApiKey: jest.fn(),
  getUsageRecords: jest.fn()
}))

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/utils/costCalculator', () => ({
  calculateCost: jest.fn(),
  formatCost: jest.fn()
}))

jest.mock('../src/services/pricingService', () => ({
  getStatus: jest.fn()
}))

const redis = require('../src/models/redis')
const CostCalculator = require('../src/utils/costCalculator')
const gcpVertexAccountService = require('../src/services/account/gcpVertexAccountService')
const router = require('../src/routes/admin/usageStats')

describe('Usage Stats Admin Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const getApiKeyUsageRecordsHandler = () => {
    const routeLayer = router.stack.find(
      (layer) =>
        layer.route &&
        layer.route.path === '/api-keys/:keyId/usage-records' &&
        layer.route.methods.get
    )

    return routeLayer.route.stack[routeLayer.route.stack.length - 1].handle
  }

  const createMockResponse = () => {
    const res = {}
    res.status = jest.fn().mockReturnValue(res)
    res.json = jest.fn().mockReturnValue(res)
    return res
  }

  it('resolves GCP Vertex account info for usage records', async () => {
    const handler = getApiKeyUsageRecordsHandler()
    const req = {
      params: { keyId: 'key-1' },
      query: {}
    }
    const res = createMockResponse()

    redis.getApiKey.mockResolvedValue({ name: 'Test Key' })
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-02-14T10:00:00.000Z',
        model: 'claude-3',
        accountId: 'vertex-1',
        accountType: 'claude-vertex',
        inputTokens: 10,
        outputTokens: 20
      }
    ])
    gcpVertexAccountService.getAccount.mockResolvedValue({
      id: 'vertex-1',
      name: 'Vertex Account',
      status: 'active'
    })
    CostCalculator.calculateCost.mockReturnValue({
      costs: {
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        total: 0
      }
    })
    CostCalculator.formatCost.mockReturnValue('$0.00')

    await handler(req, res)

    expect(gcpVertexAccountService.getAccount).toHaveBeenCalledWith('vertex-1')
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          records: [
            expect.objectContaining({
              accountId: 'vertex-1',
              accountName: 'Vertex Account',
              accountStatus: 'active',
              accountType: 'claude-vertex'
            })
          ]
        })
      })
    )
  })
})
