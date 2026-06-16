const claudeAccountService = require('./account/claudeAccountService')
const claudeConsoleAccountService = require('./account/claudeConsoleAccountService')
const gcpVertexAccountService = require('./account/gcpVertexAccountService')
const bedrockAccountService = require('./account/bedrockAccountService')
const ccrAccountService = require('./account/ccrAccountService')
const bridgeAccountService = require('./account/claudeOpenAIBridgeAccountService')
const { parseBridgeRoutingRules } = require('../utils/bridgeRoutingRules')

const sourceAccountLoaders = {
  claude: (accountId) => claudeAccountService.getAccount(accountId),
  'claude-official': (accountId) => claudeAccountService.getAccount(accountId),
  'claude-console': (accountId) => claudeConsoleAccountService.getAccount(accountId),
  'claude-vertex': (accountId) => gcpVertexAccountService.getAccount(accountId),
  bedrock: (accountId) => bedrockAccountService.getAccount(accountId),
  ccr: (accountId) => ccrAccountService.getAccount(accountId)
}

function unwrapAccountResult(result) {
  if (result && typeof result === 'object' && 'success' in result) {
    return result.success ? result.data : null
  }
  return result || null
}

async function loadSourceAccount(sourceAccountId, sourceAccountType) {
  const loader = sourceAccountLoaders[sourceAccountType]
  if (!loader || !sourceAccountId) {
    return null
  }

  return unwrapAccountResult(await loader(sourceAccountId))
}

function findMatchingRule(sourceAccount, sourceModel) {
  const rules = parseBridgeRoutingRules(sourceAccount?.bridgeRoutingRules)
  return rules.find((rule) => rule.enabled && rule.sourceModel === sourceModel) || null
}

async function resolveBridgeSelection({ sourceAccountId, sourceAccountType, sourceModel } = {}) {
  const config = await bridgeAccountService.getConfig()
  if (!config?.enabled) {
    return null
  }

  const sourceAccount = await loadSourceAccount(sourceAccountId, sourceAccountType)
  const mapping = findMatchingRule(sourceAccount, sourceModel)
  if (!sourceAccount || !mapping) {
    return null
  }

  const account = await bridgeAccountService.getSchedulableAccount(mapping.bridgeAccountId)
  if (!account) {
    return null
  }

  return {
    account,
    mapping,
    sourceAccount: {
      id: sourceAccount.id || sourceAccountId,
      type: sourceAccountType,
      name: sourceAccount.name || sourceAccount.email || sourceAccountId
    }
  }
}

module.exports = {
  resolveBridgeSelection,
  _findMatchingRule: findMatchingRule,
  _loadSourceAccount: loadSourceAccount
}
