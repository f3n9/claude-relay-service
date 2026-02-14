function hasExplicitDedicatedClaudeBinding(apiKey) {
  const isClaudeGroupBinding =
    typeof apiKey?.claudeAccountId === 'string' && apiKey.claudeAccountId.startsWith('group:')
  const isVertexGroupBinding =
    typeof apiKey?.claudeVertexAccountId === 'string' &&
    apiKey.claudeVertexAccountId.startsWith('group:')

  return !!(
    (apiKey?.claudeAccountId && !isClaudeGroupBinding) ||
    apiKey?.claudeConsoleAccountId ||
    apiKey?.bedrockAccountId ||
    (apiKey?.claudeVertexAccountId && !isVertexGroupBinding)
  )
}

function getCountTokensFallbackGroupId(apiKey) {
  if (typeof apiKey?.claudeAccountId === 'string' && apiKey.claudeAccountId.startsWith('group:')) {
    return apiKey.claudeAccountId.replace('group:', '')
  }

  if (
    typeof apiKey?.claudeVertexAccountId === 'string' &&
    apiKey.claudeVertexAccountId.startsWith('group:')
  ) {
    return apiKey.claudeVertexAccountId.replace('group:', '')
  }

  return null
}

async function selectCountTokensCapableFallbackAccount(
  availableAccounts,
  isCountTokensUnavailable = async () => false
) {
  if (!Array.isArray(availableAccounts) || availableAccounts.length === 0) {
    return null
  }

  for (const account of availableAccounts) {
    if (account.accountType === 'claude-official') {
      return {
        accountId: account.accountId,
        accountType: account.accountType
      }
    }

    if (account.accountType === 'claude-console') {
      const isUnavailable = await isCountTokensUnavailable(account.accountId)
      if (!isUnavailable) {
        return {
          accountId: account.accountId,
          accountType: account.accountType
        }
      }
    }
  }

  return null
}

module.exports = {
  hasExplicitDedicatedClaudeBinding,
  getCountTokensFallbackGroupId,
  selectCountTokensCapableFallbackAccount
}
