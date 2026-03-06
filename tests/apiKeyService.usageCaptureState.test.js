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

jest.mock('../src/services/pricingService', () => ({
  pricingData: { loaded: true },
  initialize: jest.fn().mockResolvedValue(undefined),
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
  database: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

const redis = require('../src/models/redis')
const apiKeyService = require('../src/services/apiKeyService')

describe('apiKeyService recordUsageWithDetails usageCaptureState', () => {
  beforeEach(() => {
    jest.clearAllMocks()
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
})
