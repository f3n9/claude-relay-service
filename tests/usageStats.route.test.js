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

jest.mock('../src/services/apiKeyService', () => ({
  getAllApiKeysFast: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getApiKey: jest.fn(),
  getUsageRecords: jest.fn(),
  getAccountUsageStats: jest.fn(),
  getDateInTimezone: jest.fn(),
  getDateStringInTimezone: jest.fn(),
  getClientSafe: jest.fn(),
  scanAndGetAllChunked: jest.fn(),
  batchHgetallChunked: jest.fn(),
  scanKeys: jest.fn(),
  client: {
    smembers: jest.fn(),
    get: jest.fn(),
    setex: jest.fn(),
    sadd: jest.fn()
  }
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
const apiKeyService = require('../src/services/apiKeyService')
const router = require('../src/routes/admin/usageStats')

describe('Usage Stats Admin Routes', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    CostCalculator.calculateCost.mockReturnValue({
      costs: {
        input: 0,
        output: 0,
        cacheWrite: 0,
        cacheRead: 0,
        total: 0
      }
    })
    CostCalculator.formatCost.mockImplementation((value) => `$${Number(value).toFixed(6)}`)
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

  const getAccountUsageHistoryHandler = () => {
    const routeLayer = router.stack.find(
      (layer) =>
        layer.route &&
        layer.route.path === '/accounts/:accountId/usage-history' &&
        layer.route.methods.get
    )

    return routeLayer.route.stack[routeLayer.route.stack.length - 1].handle
  }

  const getAccountUsageRecordsHandler = () => {
    const routeLayer = router.stack.find(
      (layer) =>
        layer.route &&
        layer.route.path === '/accounts/:accountId/usage-records' &&
        layer.route.methods.get
    )

    return routeLayer.route.stack[routeLayer.route.stack.length - 1].handle
  }

  const getUsageCostsHandler = () => {
    const routeLayer = router.stack.find(
      (layer) => layer.route && layer.route.path === '/usage-costs' && layer.route.methods.get
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

  it('allows usage history for GCP Vertex platform', async () => {
    const handler = getAccountUsageHistoryHandler()
    const req = {
      params: { accountId: 'vertex-1' },
      query: { platform: 'claude-vertex', days: '1' }
    }
    const res = createMockResponse()

    const mockClient = {
      hgetall: jest.fn().mockResolvedValue({
        inputTokens: '0',
        outputTokens: '0',
        cacheCreateTokens: '0',
        cacheReadTokens: '0',
        requests: '0',
        allTokens: '0'
      })
    }

    gcpVertexAccountService.getAccount.mockResolvedValue({
      id: 'vertex-1',
      createdAt: '2026-02-01T00:00:00.000Z'
    })
    redis.getAccountUsageStats.mockResolvedValue({})
    redis.getDateInTimezone.mockImplementation((date) => date)
    redis.getDateStringInTimezone.mockReturnValue('2026-02-14')
    redis.getClientSafe.mockReturnValue(mockClient)
    redis.scanAndGetAllChunked.mockResolvedValue([])
    CostCalculator.calculateCost.mockReturnValue({ costs: { total: 0 } })
    CostCalculator.formatCost.mockReturnValue('$0.00')

    await handler(req, res)

    expect(res.status).not.toHaveBeenCalledWith(400)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: true,
        data: expect.objectContaining({
          history: expect.any(Array),
          summary: expect.any(Object),
          overview: expect.any(Object)
        })
      })
    )
  })

  it('returns real/rated/display costs for api key usage records in real mode', async () => {
    const handler = getApiKeyUsageRecordsHandler()
    const req = {
      params: { keyId: 'key-1' },
      query: { costMode: 'real' }
    }
    const res = createMockResponse()

    redis.getApiKey.mockResolvedValue({ id: 'key-1', name: 'Test Key' })
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-02-14T10:00:00.000Z',
        model: 'claude-3',
        accountId: 'vertex-1',
        accountType: 'claude-vertex',
        inputTokens: 10,
        outputTokens: 20,
        cost: 0.2,
        realCost: 0.6
      }
    ])
    gcpVertexAccountService.getAccount.mockResolvedValue({
      id: 'vertex-1',
      name: 'Vertex Account',
      status: 'active'
    })

    await handler(req, res)

    const response = res.json.mock.calls[0][0]
    expect(response.success).toBe(true)
    expect(response.data.records).toHaveLength(1)
    expect(response.data.records[0]).toMatchObject({
      cost: 0.6,
      ratedCost: 0.2,
      realCost: 0.6,
      displayCost: 0.6,
      displayCostMode: 'real'
    })
    expect(response.data.summary).toMatchObject({
      totalCost: 0.6,
      totalDisplayCost: 0.6,
      totalRatedCost: 0.2,
      totalRealCost: 0.6,
      avgCost: 0.6,
      avgRatedCost: 0.2,
      avgRealCost: 0.6,
      displayCostMode: 'real'
    })
    expect(response.data.filters.costMode).toBe('real')
  })

  it('returns rated display costs for account usage records when costMode=rated', async () => {
    const handler = getAccountUsageRecordsHandler()
    const req = {
      params: { accountId: 'vertex-1' },
      query: { platform: 'claude-vertex', costMode: 'rated' }
    }
    const res = createMockResponse()

    gcpVertexAccountService.getAccount.mockResolvedValue({
      id: 'vertex-1',
      name: 'Vertex Account',
      status: 'active'
    })
    apiKeyService.getAllApiKeysFast.mockResolvedValue([{ id: 'key-1', name: 'Key 1' }])
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-02-14T10:00:00.000Z',
        model: 'claude-3',
        accountId: 'vertex-1',
        accountType: 'claude-vertex',
        inputTokens: 10,
        outputTokens: 20,
        cost: 0.2,
        realCost: 0.6
      }
    ])

    await handler(req, res)

    const response = res.json.mock.calls[0][0]
    expect(response.success).toBe(true)
    expect(response.data.records).toHaveLength(1)
    expect(response.data.records[0]).toMatchObject({
      cost: 0.2,
      ratedCost: 0.2,
      realCost: 0.6,
      displayCost: 0.2,
      displayCostMode: 'rated'
    })
    expect(response.data.summary).toMatchObject({
      totalCost: 0.2,
      totalDisplayCost: 0.2,
      totalRatedCost: 0.2,
      totalRealCost: 0.6,
      avgCost: 0.2,
      avgRatedCost: 0.2,
      avgRealCost: 0.6,
      displayCostMode: 'rated'
    })
    expect(response.data.filters.costMode).toBe('rated')
  })

  it('filters api key usage records by claude-vertex reconciliation fields', async () => {
    const handler = getApiKeyUsageRecordsHandler()
    const req = {
      params: { keyId: 'key-1' },
      query: {
        accountType: 'claude-vertex',
        usageCaptureState: 'partial',
        requestRegion: 'us-east5'
      }
    }
    const res = createMockResponse()

    redis.getApiKey.mockResolvedValue({ id: 'key-1', name: 'Test Key' })
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-02-14T10:00:00.000Z',
        model: 'claude-opus-4-6',
        accountId: 'vertex-1',
        accountType: 'claude-vertex',
        inputTokens: 10,
        outputTokens: 0,
        usageCaptureState: 'partial',
        requestRegion: 'us-east5',
        cost: 0.2,
        realCost: 0.6
      },
      {
        timestamp: '2026-02-14T11:00:00.000Z',
        model: 'claude-opus-4-6',
        accountId: 'vertex-1',
        accountType: 'claude-vertex',
        inputTokens: 10,
        outputTokens: 5,
        usageCaptureState: 'complete',
        requestRegion: 'global',
        cost: 0.2,
        realCost: 0.6
      }
    ])
    gcpVertexAccountService.getAccount.mockResolvedValue({
      id: 'vertex-1',
      name: 'Vertex Account',
      status: 'active'
    })

    await handler(req, res)

    const response = res.json.mock.calls[0][0]
    expect(response.success).toBe(true)
    expect(response.data.records).toHaveLength(1)
    expect(response.data.records[0]).toMatchObject({
      accountType: 'claude-vertex',
      usageCaptureState: 'partial',
      requestRegion: 'us-east5'
    })
    expect(response.data.filters).toMatchObject({
      accountType: 'claude-vertex',
      usageCaptureState: 'partial',
      requestRegion: 'us-east5'
    })
    expect(response.data.availableFilters).toMatchObject({
      accountTypes: expect.arrayContaining(['claude-vertex']),
      usageCaptureStates: expect.arrayContaining(['partial', 'complete']),
      requestRegions: expect.arrayContaining(['us-east5', 'global'])
    })
  })

  it('filters account usage records by claude-vertex reconciliation fields', async () => {
    const handler = getAccountUsageRecordsHandler()
    const req = {
      params: { accountId: 'vertex-1' },
      query: {
        platform: 'claude-vertex',
        usageCaptureState: 'partial',
        requestRegion: 'us-central1'
      }
    }
    const res = createMockResponse()

    gcpVertexAccountService.getAccount.mockResolvedValue({
      id: 'vertex-1',
      name: 'Vertex Account',
      status: 'active'
    })
    apiKeyService.getAllApiKeysFast.mockResolvedValue([{ id: 'key-1', name: 'Key 1' }])
    redis.getUsageRecords.mockResolvedValue([
      {
        timestamp: '2026-02-14T10:00:00.000Z',
        model: 'claude-opus-4-6',
        accountId: 'vertex-1',
        accountType: 'claude-vertex',
        inputTokens: 10,
        outputTokens: 0,
        usageCaptureState: 'partial',
        requestRegion: 'us-central1',
        cost: 0.2,
        realCost: 0.6
      },
      {
        timestamp: '2026-02-14T11:00:00.000Z',
        model: 'claude-opus-4-6',
        accountId: 'vertex-1',
        accountType: 'claude-vertex',
        inputTokens: 10,
        outputTokens: 5,
        usageCaptureState: 'complete',
        requestRegion: 'global',
        cost: 0.2,
        realCost: 0.6
      }
    ])

    await handler(req, res)

    const response = res.json.mock.calls[0][0]
    expect(response.success).toBe(true)
    expect(response.data.records).toHaveLength(1)
    expect(response.data.records[0]).toMatchObject({
      accountType: 'claude-vertex',
      usageCaptureState: 'partial',
      requestRegion: 'us-central1'
    })
    expect(response.data.filters).toMatchObject({
      usageCaptureState: 'partial',
      requestRegion: 'us-central1'
    })
    expect(response.data.availableFilters).toMatchObject({
      accountTypes: expect.arrayContaining(['claude-vertex']),
      usageCaptureStates: expect.arrayContaining(['partial', 'complete']),
      requestRegions: expect.arrayContaining(['us-central1', 'global'])
    })
  })

  it('prefers stored micro-costs for 7days usage-costs summary', async () => {
    const handler = getUsageCostsHandler()
    const req = {
      query: { period: '7days' }
    }
    const res = createMockResponse()

    redis.getClientSafe.mockReturnValue({})
    redis.getDateStringInTimezone.mockReturnValue('2026-03-12')
    redis.getDateInTimezone.mockImplementation(
      (date = new Date('2026-03-12T00:00:00.000Z')) => date
    )
    let dailyIndexHitCount = 0
    redis.client.smembers.mockImplementation(async (key) => {
      if (key.startsWith('usage:model:daily:index:')) {
        dailyIndexHitCount += 1
        if (dailyIndexHitCount === 1) {
          return ['claude-opus-4-6']
        }
        return []
      }
      return []
    })
    redis.client.get.mockResolvedValue(null)
    redis.scanKeys.mockResolvedValue([])
    let dailyDataHitCount = 0
    redis.batchHgetallChunked.mockImplementation(async (keys) =>
      keys.map((key) => {
        if (key.startsWith('usage:model:daily:claude-opus-4-6:')) {
          dailyDataHitCount += 1
          if (dailyDataHitCount === 1) {
            return {
              inputTokens: '100',
              outputTokens: '50',
              cacheCreateTokens: '10',
              cacheReadTokens: '5',
              ratedCostMicro: '2500000',
              realCostMicro: '3100000'
            }
          }
        }
        return {}
      })
    )
    CostCalculator.calculateCost.mockReturnValue({
      costs: {
        input: 9,
        output: 9,
        cacheWrite: 9,
        cacheRead: 9,
        total: 36
      },
      formatted: {
        total: '$36.000000'
      },
      usingDynamicPricing: true
    })

    await handler(req, res)

    const response = res.json.mock.calls[0][0]
    expect(CostCalculator.calculateCost).not.toHaveBeenCalled()
    expect(response.success).toBe(true)
    expect(response.data.totalCosts.totalCost).toBe(2.5)
    expect(response.data.modelCosts).toEqual([
      expect.objectContaining({
        model: 'claude-opus-4-6',
        costs: expect.objectContaining({
          total: 2.5,
          real: 3.1
        }),
        usingDynamicPricing: false,
        usingStoredCost: true
      })
    ])
  })

  it('prefers stored micro-costs for all-period usage-costs summary', async () => {
    const handler = getUsageCostsHandler()
    const req = {
      query: { period: 'all' }
    }
    const res = createMockResponse()

    redis.getClientSafe.mockReturnValue({})
    redis.getDateStringInTimezone.mockReturnValue('2026-03-12')
    redis.getDateInTimezone.mockImplementation(
      (date = new Date('2026-03-12T00:00:00.000Z')) => date
    )
    redis.client.smembers.mockImplementation(async (key) => {
      if (key === 'usage:model:monthly:months') {
        return ['2026-03']
      }
      if (key === 'usage:model:monthly:index:2026-03') {
        return ['claude-sonnet-4-6']
      }
      return []
    })
    redis.client.get.mockResolvedValue(null)
    redis.scanKeys.mockResolvedValue([])
    redis.batchHgetallChunked.mockImplementation(async (keys) =>
      keys.map((key) => {
        if (key === 'usage:model:monthly:claude-sonnet-4-6:2026-03') {
          return {
            inputTokens: '1000',
            outputTokens: '500',
            cacheCreateTokens: '20',
            cacheReadTokens: '10',
            ratedCostMicro: '1500000',
            realCostMicro: '1900000'
          }
        }
        return {}
      })
    )
    CostCalculator.calculateCost.mockReturnValue({
      costs: {
        input: 5,
        output: 5,
        cacheWrite: 5,
        cacheRead: 5,
        total: 20
      },
      formatted: {
        total: '$20.000000'
      },
      usingDynamicPricing: true
    })

    await handler(req, res)

    const response = res.json.mock.calls[0][0]
    expect(CostCalculator.calculateCost).not.toHaveBeenCalled()
    expect(response.success).toBe(true)
    expect(response.data.totalCosts.totalCost).toBe(1.5)
    expect(response.data.modelCosts).toEqual([
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        costs: expect.objectContaining({
          total: 1.5,
          real: 1.9
        }),
        usingDynamicPricing: false,
        usingStoredCost: true
      })
    ])
  })
})
