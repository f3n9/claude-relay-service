jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../src/services/account/claudeAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/gcpVertexAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/geminiAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/geminiApiAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/openaiAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/azureOpenaiAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/bedrockAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/droidAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/account/ccrAccountService', () => ({
  getAllAccounts: jest.fn()
}))
jest.mock('../src/services/accountGroupService', () => ({
  getAllGroups: jest.fn()
}))

const claudeAccountService = require('../src/services/account/claudeAccountService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const gcpVertexAccountService = require('../src/services/account/gcpVertexAccountService')
const geminiAccountService = require('../src/services/account/geminiAccountService')
const geminiApiAccountService = require('../src/services/account/geminiApiAccountService')
const openaiAccountService = require('../src/services/account/openaiAccountService')
const openaiResponsesAccountService = require('../src/services/account/openaiResponsesAccountService')
const azureOpenaiAccountService = require('../src/services/account/azureOpenaiAccountService')
const bedrockAccountService = require('../src/services/account/bedrockAccountService')
const droidAccountService = require('../src/services/account/droidAccountService')
const ccrAccountService = require('../src/services/account/ccrAccountService')
const accountGroupService = require('../src/services/accountGroupService')
const accountNameCacheService = require('../src/services/accountNameCacheService')

describe('AccountNameCacheService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    accountNameCacheService.clearCache()

    claudeAccountService.getAllAccounts.mockResolvedValue([])
    claudeConsoleAccountService.getAllAccounts.mockResolvedValue([])
    gcpVertexAccountService.getAllAccounts.mockResolvedValue({
      success: true,
      data: [{ id: 'vertex-1', name: 'Vertex Account 1' }]
    })
    geminiAccountService.getAllAccounts.mockResolvedValue([])
    geminiApiAccountService.getAllAccounts.mockResolvedValue([])
    openaiAccountService.getAllAccounts.mockResolvedValue([])
    openaiResponsesAccountService.getAllAccounts.mockResolvedValue([])
    azureOpenaiAccountService.getAllAccounts.mockResolvedValue([])
    bedrockAccountService.getAllAccounts.mockResolvedValue([])
    droidAccountService.getAllAccounts.mockResolvedValue([])
    ccrAccountService.getAllAccounts.mockResolvedValue([])
    accountGroupService.getAllGroups.mockResolvedValue([])
  })

  it('loads GCP Vertex account names into cache during refresh', async () => {
    await accountNameCacheService.refresh()

    expect(accountNameCacheService.getAccountDisplayName('vertex-1')).toBe('Vertex Account 1')
  })

  it('includes claudeVertexAccountId in binding-account search', () => {
    accountNameCacheService.accountCache.set('vertex-only', {
      name: 'Vertex Only Binding',
      platform: 'claude-vertex'
    })

    const apiKeys = [{ id: 'key-1', claudeVertexAccountId: 'vertex-only' }]
    const result = accountNameCacheService.searchByBindingAccount(apiKeys, 'vertex only')

    expect(result).toHaveLength(1)
  })
})
