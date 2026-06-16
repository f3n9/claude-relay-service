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

describe('redis account usage stats', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(Date.parse('2026-06-16T00:00:00.000Z'))
    redis.client = {
      hgetall: jest.fn(async (key) => {
        if (key === 'account_usage:bridge-1') {
          return {
            totalTokens: '144000',
            totalRequests: '144'
          }
        }
        if (key.startsWith('account_usage:daily:') || key.startsWith('account_usage:monthly:')) {
          return {}
        }
        if (key === 'claude_openai_bridge_account:bridge-1') {
          return {
            id: 'bridge-1',
            name: 'Bridge 1',
            createdAt: '2026-06-14T00:00:00.000Z'
          }
        }
        return {}
      }),
      get: jest.fn(),
      smembers: jest.fn(async () => [])
    }
  })

  afterEach(() => {
    jest.useRealTimers()
    redis.client = null
  })

  it('uses Claude OpenAI bridge account metadata when computing averages', async () => {
    const result = await redis.getAccountUsageStats('bridge-1', 'claude-openai-bridge')

    expect(redis.client.hgetall).toHaveBeenCalledWith('claude_openai_bridge_account:bridge-1')
    expect(result.averages.dailyRequests).toBe(72)
    expect(result.averages.dailyTokens).toBe(72000)
  })
})
