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

module.exports = {
  hasExplicitDedicatedClaudeBinding
}
