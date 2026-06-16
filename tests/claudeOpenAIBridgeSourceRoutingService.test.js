jest.mock('../src/services/account/claudeAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/claudeConsoleAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/gcpVertexAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/bedrockAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/ccrAccountService', () => ({
  getAccount: jest.fn()
}))

jest.mock('../src/services/account/claudeOpenAIBridgeAccountService', () => ({
  getConfig: jest.fn(),
  getSchedulableAccount: jest.fn()
}))

const claudeAccountService = require('../src/services/account/claudeAccountService')
const claudeConsoleAccountService = require('../src/services/account/claudeConsoleAccountService')
const gcpVertexAccountService = require('../src/services/account/gcpVertexAccountService')
const bedrockAccountService = require('../src/services/account/bedrockAccountService')
const ccrAccountService = require('../src/services/account/ccrAccountService')
const bridgeAccountService = require('../src/services/account/claudeOpenAIBridgeAccountService')
const sourceRoutingService = require('../src/services/claudeOpenAIBridgeSourceRoutingService')

const enabledRule = {
  sourceModel: 'deepseek-v4-flash',
  bridgeAccountId: 'bridge-1',
  targetModel: 'DeepSeek-V4-Flash',
  enabled: true
}

describe('claudeOpenAIBridgeSourceRoutingService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    bridgeAccountService.getConfig.mockResolvedValue({ enabled: true })
    bridgeAccountService.getSchedulableAccount.mockResolvedValue({
      id: 'bridge-1',
      name: 'Bridge 1',
      endpointUrl: 'https://bridge.example.com/v1',
      apiKey: 'secret'
    })
  })

  it('resolves a matching rule from the selected Claude official account', async () => {
    claudeAccountService.getAccount.mockResolvedValue({
      id: 'claude-1',
      name: 'Claude 1',
      bridgeRoutingRules: [enabledRule]
    })

    await expect(
      sourceRoutingService.resolveBridgeSelection({
        sourceAccountId: 'claude-1',
        sourceAccountType: 'claude-official',
        sourceModel: 'deepseek-v4-flash'
      })
    ).resolves.toMatchObject({
      account: { id: 'bridge-1' },
      mapping: {
        sourceModel: 'deepseek-v4-flash',
        targetModel: 'DeepSeek-V4-Flash'
      },
      sourceAccount: {
        id: 'claude-1',
        type: 'claude-official',
        name: 'Claude 1'
      }
    })

    expect(bridgeAccountService.getSchedulableAccount).toHaveBeenCalledWith('bridge-1')
  })

  it.each([
    ['claude-console', claudeConsoleAccountService, { id: 'console-1' }],
    ['claude-vertex', gcpVertexAccountService, { id: 'vertex-1' }],
    ['bedrock', bedrockAccountService, { success: true, data: { id: 'bedrock-1' } }],
    ['ccr', ccrAccountService, { id: 'ccr-1' }]
  ])('loads bridge rules from selected %s accounts', async (sourceAccountType, service, account) => {
    const accountWithRules =
      account && typeof account === 'object' && 'success' in account
        ? {
            ...account,
            data: {
              ...account.data,
              name: `${sourceAccountType} source`,
              bridgeRoutingRules: JSON.stringify([enabledRule])
            }
          }
        : {
            ...account,
            name: `${sourceAccountType} source`,
            bridgeRoutingRules: JSON.stringify([enabledRule])
          }

    service.getAccount.mockResolvedValue(accountWithRules)

    await expect(
      sourceRoutingService.resolveBridgeSelection({
        sourceAccountId: account.data?.id || account.id,
        sourceAccountType,
        sourceModel: 'deepseek-v4-flash'
      })
    ).resolves.toMatchObject({
      account: { id: 'bridge-1' },
      mapping: enabledRule,
      sourceAccount: {
        id: account.data?.id || account.id,
        type: sourceAccountType,
        name: `${sourceAccountType} source`
      }
    })
  })

  it('returns null for disabled config, disabled rules, non-matching models, and unschedulable bridge accounts', async () => {
    claudeAccountService.getAccount.mockResolvedValue({
      id: 'claude-1',
      name: 'Claude 1',
      bridgeRoutingRules: [{ ...enabledRule, enabled: false }]
    })

    await expect(
      sourceRoutingService.resolveBridgeSelection({
        sourceAccountId: 'claude-1',
        sourceAccountType: 'claude-official',
        sourceModel: 'deepseek-v4-flash'
      })
    ).resolves.toBeNull()

    claudeAccountService.getAccount.mockResolvedValue({
      id: 'claude-1',
      name: 'Claude 1',
      bridgeRoutingRules: [enabledRule]
    })
    await expect(
      sourceRoutingService.resolveBridgeSelection({
        sourceAccountId: 'claude-1',
        sourceAccountType: 'claude-official',
        sourceModel: 'kimi-k2.6'
      })
    ).resolves.toBeNull()

    bridgeAccountService.getSchedulableAccount.mockResolvedValue(null)
    await expect(
      sourceRoutingService.resolveBridgeSelection({
        sourceAccountId: 'claude-1',
        sourceAccountType: 'claude-official',
        sourceModel: 'deepseek-v4-flash'
      })
    ).resolves.toBeNull()

    bridgeAccountService.getConfig.mockResolvedValue({ enabled: false })
    await expect(
      sourceRoutingService.resolveBridgeSelection({
        sourceAccountId: 'claude-1',
        sourceAccountType: 'claude-official',
        sourceModel: 'deepseek-v4-flash'
      })
    ).resolves.toBeNull()
  })
})
