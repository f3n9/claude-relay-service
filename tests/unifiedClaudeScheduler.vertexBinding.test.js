jest.mock('../src/services/account/claudeAccountService', () => ({
  isAccountRateLimited: jest.fn(),
  getAccountRateLimitInfo: jest.fn(),
  clearExpiredOpusRateLimit: jest.fn()
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn(),
  isAccountRateLimited: jest.fn(),
  isAccountQuotaExceeded: jest.fn(),
  checkQuotaUsage: jest.fn(),
  isModelSupported: jest.fn()
}))

jest.mock('../src/services/account/bedrockAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/gcpVertexAccountService', () => ({
  getAccount: jest.fn(),
  isAccountRateLimited: jest.fn()
}))

jest.mock('../src/services/account/ccrAccountService', () => ({
  isModelSupported: jest.fn()
}))

jest.mock('../src/services/accountGroupService', () => ({
  getGroup: jest.fn(),
  getGroupMembers: jest.fn()
}))

jest.mock('../src/models/redis', () => ({
  getClaudeAccount: jest.fn()
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock('../src/utils/modelHelper', () => ({
  parseVendorPrefixedModel: jest.fn(),
  isOpus45OrNewer: jest.fn(),
  isClaudeFamilyModel: jest.fn()
}))

jest.mock('../src/utils/commonHelper', () => ({
  isSchedulable: jest.fn(),
  sortAccountsByPriority: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  isAccountTemporarilyUnavailable: jest.fn()
}))

const gcpVertexAccountService = require('../src/services/account/gcpVertexAccountService')
const { parseVendorPrefixedModel } = require('../src/utils/modelHelper')
const { isSchedulable, sortAccountsByPriority } = require('../src/utils/commonHelper')
const unifiedClaudeScheduler = require('../src/services/scheduler/unifiedClaudeScheduler')

describe('unifiedClaudeScheduler Vertex binding model gate', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    parseVendorPrefixedModel.mockImplementation((model) => ({ vendor: null, baseModel: model }))
    isSchedulable.mockReturnValue(true)
    sortAccountsByPriority.mockImplementation((accounts) => accounts)
    gcpVertexAccountService.isAccountRateLimited.mockResolvedValue(false)
  })

  it('falls back to pool when bound Vertex account does not support requested model', async () => {
    gcpVertexAccountService.getAccount.mockResolvedValue({
      id: 'vertex-1',
      name: 'Vertex 1',
      isActive: true,
      schedulable: true
    })

    jest.spyOn(unifiedClaudeScheduler, 'isAccountTemporarilyUnavailable').mockResolvedValue(false)
    jest.spyOn(unifiedClaudeScheduler, '_isModelSupportedByAccount').mockReturnValue(false)
    jest.spyOn(unifiedClaudeScheduler, '_getAllAvailableAccounts').mockResolvedValue([
      {
        accountId: 'official-1',
        accountType: 'claude-official',
        name: 'Official 1',
        priority: 50,
        lastUsedAt: '0'
      }
    ])

    const selected = await unifiedClaudeScheduler.selectAccountForApiKey(
      {
        name: 'key-1',
        claudeVertexAccountId: 'vertex-1'
      },
      null,
      'not-a-claude-model'
    )

    expect(unifiedClaudeScheduler._isModelSupportedByAccount).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vertex-1' }),
      'claude-vertex',
      'not-a-claude-model'
    )
    expect(selected).toEqual({
      accountId: 'official-1',
      accountType: 'claude-official'
    })
  })
})
