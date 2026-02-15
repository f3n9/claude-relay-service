function hasExplicitDedicatedClaudeBinding(apiKey) {
  const isClaudeGroupBinding =
    typeof apiKey?.claudeAccountId === 'string' &&
    apiKey.claudeAccountId.startsWith('group:')
  const isVertexGroupBindingFromClaude =
    typeof apiKey?.claudeAccountId === 'string' &&
    apiKey.claudeAccountId.startsWith('vertex:group:')
  const isVertexGroupBinding =
    typeof apiKey?.claudeVertexAccountId === 'string' &&
    apiKey.claudeVertexAccountId.startsWith('group:')

  return !!(
    (apiKey?.claudeAccountId &&
      !isClaudeGroupBinding &&
      !isVertexGroupBindingFromClaude) ||
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
    typeof apiKey?.claudeAccountId === 'string' &&
    apiKey.claudeAccountId.startsWith('vertex:group:')
  ) {
    return apiKey.claudeAccountId.substring(13)
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

async function selectCountTokensCapableGroupFallbackAccount(
  selectFromGroup,
  isCountTokensUnavailable = async () => false
) {
  if (typeof selectFromGroup !== 'function') {
    return null
  }

  const excludedAccountIds = new Set()

  let hasMoreCandidates = true
  while (hasMoreCandidates) {
    const candidate = await selectFromGroup(Array.from(excludedAccountIds))
    if (!candidate) {
      hasMoreCandidates = false
      continue
    }

    if (candidate.accountType === 'claude-official') {
      return candidate
    }

    if (candidate.accountType === 'claude-console') {
      const isUnavailable = await isCountTokensUnavailable(candidate.accountId)
      if (!isUnavailable) {
        return candidate
      }

      excludedAccountIds.add(candidate.accountId)
      continue
    }

    excludedAccountIds.add(candidate.accountId)
  }

  return null
}

module.exports = {
  hasExplicitDedicatedClaudeBinding,
  getCountTokensFallbackGroupId,
  selectCountTokensCapableFallbackAccount,
  selectCountTokensCapableGroupFallbackAccount
}
