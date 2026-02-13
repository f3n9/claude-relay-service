jest.mock('../src/models/redis', () => ({
  getClientSafe: jest.fn(),
  getWeekStringInTimezone: jest.fn(),
  setAccountLock: jest.fn(),
  releaseAccountLock: jest.fn(),
  scanApiKeyIds: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/services/pricingService', () => ({
  pricingData: { initialized: true },
  calculateCost: jest.fn()
}))

jest.mock('../src/services/serviceRatesService', () => ({
  getService: jest.fn(),
  getServiceRate: jest.fn()
}))

jest.mock('../src/utils/modelHelper', () => ({
  isOpusModel: jest.fn()
}))

const redis = require('../src/models/redis')
const pricingService = require('../src/services/pricingService')
const serviceRatesService = require('../src/services/serviceRatesService')
const { isOpusModel } = require('../src/utils/modelHelper')
const weeklyClaudeCostInitService = require('../src/services/weeklyClaudeCostInitService')

describe('WeeklyClaudeCostInitService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('backfills weekly Opus cost for keys bound to Vertex accounts', async () => {
    const weekString = '2026-W07'
    const dateStr = '2026-02-10'
    const keyId = 'key-1'
    const usageKey = `usage:${keyId}:model:daily:claude-opus-4-1:${dateStr}`

    const pipelineInstances = []
    let pipelineCount = 0

    const client = {
      get: jest.fn().mockResolvedValue(null),
      scan: jest.fn().mockResolvedValue(['0', [usageKey]]),
      set: jest.fn().mockResolvedValue('OK'),
      pipeline: jest.fn(() => {
        pipelineCount += 1
        const pipeline = {
          hgetall: jest.fn().mockReturnThis(),
          set: jest.fn().mockReturnThis(),
          expire: jest.fn().mockReturnThis(),
          exec: jest.fn()
        }

        if (pipelineCount === 1) {
          pipeline.exec.mockResolvedValue([
            [
              null,
              {
                id: keyId,
                claudeVertexAccountId: 'vertex-account-1',
                serviceRates: '{}'
              }
            ]
          ])
        } else if (pipelineCount === 2) {
          pipeline.exec.mockResolvedValue([
            [
              null,
              {
                totalInputTokens: '1000',
                totalOutputTokens: '500',
                totalCacheReadTokens: '0',
                totalCacheCreateTokens: '0'
              }
            ]
          ])
        } else {
          pipeline.exec.mockResolvedValue([
            [null, 'OK'],
            [null, 1]
          ])
        }

        pipelineInstances.push(pipeline)
        return pipeline
      })
    }

    redis.getClientSafe.mockReturnValue(client)
    redis.getWeekStringInTimezone.mockReturnValue(weekString)
    redis.setAccountLock.mockResolvedValue(true)
    redis.releaseAccountLock.mockResolvedValue(true)
    redis.scanApiKeyIds.mockResolvedValue([keyId])

    isOpusModel.mockReturnValue(true)
    pricingService.calculateCost.mockReturnValue({ totalCost: 2 })
    serviceRatesService.getService.mockReturnValue('claude')
    serviceRatesService.getServiceRate.mockResolvedValue(1)

    const dateSpy = jest
      .spyOn(weeklyClaudeCostInitService, '_getCurrentWeekDatesInTimezone')
      .mockReturnValue([dateStr])

    const result = await weeklyClaudeCostInitService.backfillCurrentWeekClaudeCosts()

    expect(result.success).toBe(true)
    expect(serviceRatesService.getService).toHaveBeenCalledWith('claude-vertex', 'claude-opus-4-1')
    expect(pipelineInstances[2].set).toHaveBeenCalledWith(`usage:opus:weekly:${keyId}:${weekString}`, '2')

    dateSpy.mockRestore()
  })
})
