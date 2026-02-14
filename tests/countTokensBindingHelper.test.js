const {
  hasExplicitDedicatedClaudeBinding,
  getCountTokensFallbackGroupId,
  selectCountTokensCapableFallbackAccount,
  selectCountTokensCapableGroupFallbackAccount
} = require('../src/routes/countTokensBindingHelper')

describe('countTokensBindingHelper', () => {
  it('treats group-prefixed Vertex bindings as non-dedicated', () => {
    const apiKey = {
      claudeVertexAccountId: 'group:vertex-group-1'
    }

    expect(hasExplicitDedicatedClaudeBinding(apiKey)).toBe(false)
  })

  it('extracts fallback group id from Vertex group bindings', () => {
    const apiKey = {
      claudeVertexAccountId: 'group:vertex-group-1'
    }

    expect(getCountTokensFallbackGroupId(apiKey)).toBe('vertex-group-1')
  })

  it('skips count_tokens-unavailable console accounts in fallback selection', async () => {
    const availableAccounts = [
      { accountId: 'console-1', accountType: 'claude-console' },
      { accountId: 'official-1', accountType: 'claude-official' }
    ]
    const isCountTokensUnavailable = jest.fn(async (accountId) => accountId === 'console-1')

    const selected = await selectCountTokensCapableFallbackAccount(
      availableAccounts,
      isCountTokensUnavailable
    )

    expect(selected).toEqual({ accountId: 'official-1', accountType: 'claude-official' })
  })

  it('keeps scanning group fallback candidates when first console is unavailable', async () => {
    const selectFromGroup = jest
      .fn()
      .mockResolvedValueOnce({ accountId: 'console-1', accountType: 'claude-console' })
      .mockResolvedValueOnce({ accountId: 'console-2', accountType: 'claude-console' })
    const isCountTokensUnavailable = jest.fn(async (accountId) => accountId === 'console-1')

    const selected = await selectCountTokensCapableGroupFallbackAccount(
      selectFromGroup,
      isCountTokensUnavailable
    )

    expect(selected).toEqual({ accountId: 'console-2', accountType: 'claude-console' })
    expect(selectFromGroup).toHaveBeenNthCalledWith(1, [])
    expect(selectFromGroup).toHaveBeenNthCalledWith(2, ['console-1'])
  })
})
