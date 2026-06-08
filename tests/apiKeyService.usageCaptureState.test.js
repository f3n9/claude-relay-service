jest.mock('../src/models/redis', () => ({
  incrementTokenUsage: jest.fn().mockResolvedValue(undefined),
  incrementDailyCost: jest.fn().mockResolvedValue(undefined),
  getApiKey: jest.fn().mockResolvedValue({
    id: 'key-1',
    name: 'Test Key',
    serviceRates: '{}'
  }),
  setApiKey: jest.fn().mockResolvedValue(undefined),
  incrementAccountUsage: jest.fn().mockResolvedValue(undefined),
  addUsageRecord: jest.fn().mockResolvedValue(undefined),
  incrementWeeklyOpusCost: jest.fn().mockResolvedValue(undefined)
}))

jest.mock('../src/services/serviceRatesService', () => ({
  getService: jest.fn(() => 'claude'),
  getServiceRate: jest.fn(async () => 1)
}))

jest.mock('../src/services/requestDetailService', () => ({
  captureRequestDetail: jest.fn().mockResolvedValue(undefined)
}))

jest.mock('../src/services/pricingService', () => ({
  pricingData: { loaded: true },
  initialize: jest.fn().mockResolvedValue(undefined),
  getModelPricing: jest.fn(() => undefined),
  calculateCost: jest.fn(() => ({
    inputCost: 0.0001,
    outputCost: 0,
    cacheCreateCost: 0,
    cacheReadCost: 0,
    ephemeral5mCost: 0,
    ephemeral1hCost: 0,
    totalCost: 0.0001,
    isLongContextRequest: false
  }))
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  success: jest.fn(),
  database: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

const redis = require('../src/models/redis')
const pricingService = require('../src/services/pricingService')
const apiKeyService = require('../src/services/apiKeyService')

describe('apiKeyService recordUsageWithDetails usageCaptureState', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    pricingService.getModelPricing.mockReturnValue(undefined)
    pricingService.calculateCost.mockReturnValue({
      inputCost: 0.0001,
      outputCost: 0,
      cacheCreateCost: 0,
      cacheReadCost: 0,
      ephemeral5mCost: 0,
      ephemeral1hCost: 0,
      totalCost: 0.0001,
      isLongContextRequest: false
    })
    jest.spyOn(apiKeyService, '_publishBillingEvent').mockResolvedValue(undefined)
  })

  afterEach(() => {
    if (apiKeyService._publishBillingEvent.mockRestore) {
      apiKeyService._publishBillingEvent.mockRestore()
    }
  })

  it('stores usageCaptureState from usage object', async () => {
    await apiKeyService.recordUsageWithDetails(
      'key-1',
      {
        input_tokens: 12,
        output_tokens: 0,
        usage_capture_state: 'partial'
      },
      'claude-opus-4-6',
      'vertex-account-1',
      'claude-vertex'
    )

    expect(redis.addUsageRecord).toHaveBeenCalledWith(
      'key-1',
      expect.objectContaining({
        usageCaptureState: 'partial'
      })
    )
  })

  it('passes calculated real and rated costs into account usage stats', async () => {
    await apiKeyService.recordUsageWithDetails(
      'key-1',
      {
        input_tokens: 1000,
        output_tokens: 200
      },
      'qwen3.6-plus',
      'console-account-1',
      'claude-console'
    )

    expect(redis.incrementAccountUsage).toHaveBeenCalledWith(
      'console-account-1',
      1200,
      1000,
      200,
      0,
      0,
      0,
      0,
      'qwen3.6-plus',
      false,
      0.0001,
      0.0001
    )
  })

  it('falls back to unknown pricing when detailed pricing has no model price', async () => {
    pricingService.calculateCost.mockReturnValue({
      inputCost: 0,
      outputCost: 0,
      cacheCreateCost: 0,
      cacheReadCost: 0,
      ephemeral5mCost: 0,
      ephemeral1hCost: 0,
      totalCost: 0,
      hasPricing: false,
      isLongContextRequest: false
    })

    const result = await apiKeyService.recordUsageWithDetails(
      'key-1',
      {
        input_tokens: 1000,
        output_tokens: 200
      },
      'qwen3.6-plus',
      'console-account-1',
      'claude-console'
    )

    expect(result).toEqual({
      realCost: 0.006,
      ratedCost: 0.006
    })
    expect(redis.incrementDailyCost).toHaveBeenCalledWith('key-1', 0.006, 0.006)
    expect(redis.incrementAccountUsage).toHaveBeenCalledWith(
      'console-account-1',
      1200,
      1000,
      200,
      0,
      0,
      0,
      0,
      'qwen3.6-plus',
      false,
      0.006,
      0.006
    )
  })
})
