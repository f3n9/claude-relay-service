function normalizeBoolean(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }
  if (typeof value === 'boolean') {
    return value
  }
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true'
  }
  return Boolean(value)
}

function normalizeBridgeRoutingRules(rules = []) {
  if (!Array.isArray(rules)) {
    return []
  }

  return rules
    .map((rule) => ({
      sourceModel: String(rule?.sourceModel || '').trim(),
      bridgeAccountId: String(rule?.bridgeAccountId || '').trim(),
      targetModel: String(rule?.targetModel || '').trim(),
      enabled: normalizeBoolean(rule?.enabled, true)
    }))
    .filter((rule) => rule.sourceModel && rule.bridgeAccountId && rule.targetModel)
}

function parseBridgeRoutingRules(value) {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return normalizeBridgeRoutingRules(value)
  }

  if (typeof value !== 'string') {
    return []
  }

  try {
    return normalizeBridgeRoutingRules(JSON.parse(value))
  } catch {
    return []
  }
}

module.exports = {
  normalizeBridgeRoutingRules,
  parseBridgeRoutingRules
}
