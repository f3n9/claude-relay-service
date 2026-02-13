jest.mock('../src/services/balanceProviders/claudeBalanceProvider', () => {
  return class MockClaudeBalanceProvider {
    queryBalance() {}
  }
})

jest.mock('../src/services/balanceProviders/claudeConsoleBalanceProvider', () => {
  return class MockClaudeConsoleBalanceProvider {
    queryBalance() {}
  }
})

jest.mock('../src/services/balanceProviders/openaiResponsesBalanceProvider', () => {
  return class MockOpenAIResponsesBalanceProvider {
    queryBalance() {}
  }
})

jest.mock('../src/services/balanceProviders/genericBalanceProvider', () => {
  return class MockGenericBalanceProvider {
    constructor(platform) {
      this.platform = platform
    }
    queryBalance() {}
  }
})

jest.mock('../src/services/balanceProviders/geminiBalanceProvider', () => {
  return class MockGeminiBalanceProvider {
    queryBalance() {}
  }
})

const { registerAllProviders } = require('../src/services/balanceProviders')

describe('balanceProviders registerAllProviders', () => {
  it('registers a provider for claude-vertex', () => {
    const balanceService = {
      registerProvider: jest.fn()
    }

    registerAllProviders(balanceService)

    expect(balanceService.registerProvider).toHaveBeenCalledWith(
      'claude-vertex',
      expect.objectContaining({
        queryBalance: expect.any(Function)
      })
    )
  })
})
