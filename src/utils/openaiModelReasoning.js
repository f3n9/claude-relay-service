// Public model-page snapshot checked 2026-09-05. See docs/openai-models.md for
// sources and the distinction between API defaults and relay-selected defaults.
// Exact model IDs only: Azure deployment aliases do not establish model identity.
const profiles = new Map([
  ['gpt-6-astra', { efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' }],
  [
    'gpt-5.6-sol',
    { efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' }
  ],
  [
    'gpt-5.6-terra',
    { efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' }
  ],
  [
    'gpt-5.6-luna',
    { efforts: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' }
  ],
  ['gpt-5.5', { efforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }],
  ['gpt-5.4', { efforts: ['none', 'low', 'medium', 'high', 'xhigh'], defaultEffort: 'none' }],
  ['gpt-5.3-codex', { efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }],
  // Images API exposes quality, not a configurable reasoning effort.
  ['gpt-image-2', { efforts: [], defaultEffort: null }]
])
const fallback = { efforts: ['medium'], defaultEffort: 'medium' }

const descriptions = {
  none: 'No reasoning effort',
  low: 'Lower reasoning effort for faster responses',
  medium: 'Balanced reasoning effort',
  high: 'Higher reasoning effort for complex tasks',
  xhigh: 'Extra high reasoning effort',
  max: 'Maximum reasoning effort'
}

function getModelReasoning(modelId, upstream = {}) {
  const profile = profiles.get(modelId) || fallback
  const hasLevels = Object.prototype.hasOwnProperty.call(upstream, 'supported_reasoning_levels')
  const hasDefault = Object.prototype.hasOwnProperty.call(upstream, 'default_reasoning_level')
  let levels = upstream.supported_reasoning_levels
  let defaultEffort = upstream.default_reasoning_level

  if (!hasLevels) {
    let { efforts } = profile
    if (hasDefault) {
      // An explicit null is an upstream decision; do not turn reasoning on.
      // If the provider declares a different default, only advertise that known value.
      if (defaultEffort === null) {
        efforts = []
      } else if (!efforts.includes(defaultEffort)) {
        efforts = [defaultEffort]
      }
    }
    levels = efforts.map((effort) => ({
      effort,
      description: descriptions[effort] || effort
    }))
  }
  if (!hasDefault) {
    const efforts = Array.isArray(levels) ? levels.map((level) => level.effort) : []
    defaultEffort = efforts.includes(profile.defaultEffort)
      ? profile.defaultEffort
      : efforts[0] || null
  }
  return {
    default_reasoning_level: defaultEffort,
    supported_reasoning_levels: levels
  }
}

function supplementModelReasoning(model) {
  return { ...model, ...getModelReasoning(model.slug, model) }
}

module.exports = { getModelReasoning, supplementModelReasoning }
