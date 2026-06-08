jest.mock(
  '../config/config',
  () => ({
    system: {
      timezoneOffset: 8
    }
  }),
  { virtual: true }
)

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/utils/costCalculator', () => ({
  calculateCost: jest.fn(() => ({
    costs: { total: 0 }
  }))
}))

const redis = require('../src/models/redis')
const CostCalculator = require('../src/utils/costCalculator')

describe('redis account daily cost', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    const today = redis.getDateStringInTimezone()

    redis.client = {
      smembers: jest.fn(async (key) =>
        key === `account_usage:model:daily:index:${today}`
          ? ['console-account-1:qwen3.6-plus', 'console-account-1:deepseek-v4-pro']
          : []
      ),
      pipeline: jest.fn(() => ({
        hgetall: jest.fn().mockReturnThis(),
        exec: jest.fn(async () => [
          [
            null,
            {
              inputTokens: '1000',
              outputTokens: '200',
              ratedCostMicro: '125000'
            }
          ],
          [
            null,
            {
              inputTokens: '800',
              outputTokens: '100',
              ratedCostMicro: '75000'
            }
          ]
        ])
      }))
    }
  })

  afterEach(() => {
    redis.client = null
  })

  it('uses stored rated micro-costs for non-GPT Claude Console models in account daily cost', async () => {
    const totalCost = await redis.getAccountDailyCost('console-account-1')

    expect(totalCost).toBeCloseTo(0.2, 6)
    expect(CostCalculator.calculateCost).not.toHaveBeenCalled()
  })
})
