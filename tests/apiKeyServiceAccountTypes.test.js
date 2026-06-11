jest.mock(
  '../config/config',
  () => ({
    security: {
      apiKeyPrefix: 'cr_',
      encryptionKey: 'test-encryption-key'
    }
  }),
  { virtual: true }
)

jest.mock('../src/models/redis', () => ({}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

jest.mock('../src/services/serviceRatesService', () => ({}))
jest.mock('../src/services/requestDetailService', () => ({}))
jest.mock('../src/services/requestBodyRuleService', () => ({
  normalizeRule: jest.fn((rule) => rule),
  validateAndNormalizeRules: jest.fn((rules) => ({ valid: true, rules }))
}))

const apiKeyService = require('../src/services/apiKeyService')

describe('apiKeyService account type metadata', () => {
  beforeEach(() => {
    jest.restoreAllMocks()
  })

  it('resolves claude-openai-bridge usage records as Claude-family accounts', async () => {
    const client = {
      hgetall: jest.fn(async (key) => {
        if (key === 'claude_openai_bridge_account:bridge-1') {
          return { id: 'bridge-1', name: 'Bridge Account 1' }
        }
        return {}
      })
    }

    const resolved = await apiKeyService._resolveAccountByUsageRecord(
      {
        accountId: 'bridge-1',
        accountType: 'claude-openai-bridge',
        model: 'claude-sonnet-4-bridge'
      },
      new Map(),
      client
    )

    expect(resolved).toEqual({
      accountId: 'bridge-1',
      accountName: 'Bridge Account 1',
      accountType: 'claude-openai-bridge',
      accountCategory: 'claude',
      rawAccountId: 'bridge-1'
    })
  })

  it('creates API keys with claude-openai-bridge bindings in key data and response metadata', async () => {
    const setApiKey = jest.fn()
    jest.spyOn(apiKeyService, '_generateSecretKey').mockReturnValue('a'.repeat(64))
    require('../src/models/redis').setApiKey = setApiKey

    const created = await apiKeyService.generateApiKey({
      name: 'Bridge bound key',
      claudeOpenAIBridgeAccountId: 'bridge-1'
    })

    expect(setApiKey).toHaveBeenCalled()
    const keyData = setApiKey.mock.calls[0][1]
    expect(keyData.claudeOpenAIBridgeAccountId).toBe('bridge-1')
    expect(created.claudeOpenAIBridgeAccountId).toBe('bridge-1')
  })

  it('unbinds claude-openai-bridge accounts from all API keys', async () => {
    const updateApiKey = jest.spyOn(apiKeyService, 'updateApiKey').mockResolvedValue({ success: true })
    jest.spyOn(apiKeyService, 'getAllApiKeysFast').mockResolvedValue([
      {
        id: 'key-1',
        name: 'bound',
        claudeOpenAIBridgeAccountId: 'bridge-1'
      },
      {
        id: 'key-2',
        name: 'other',
        claudeOpenAIBridgeAccountId: 'bridge-2'
      }
    ])

    await expect(
      apiKeyService.unbindAccountFromAllKeys('bridge-1', 'claude-openai-bridge')
    ).resolves.toBe(1)

    expect(updateApiKey).toHaveBeenCalledWith('key-1', {
      claudeOpenAIBridgeAccountId: null
    })
  })
})
