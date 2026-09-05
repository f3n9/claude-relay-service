// OpenAI /v1/models contains identifiers, not Codex capability metadata. Supply
// conservative protocol defaults only; never infer context windows or reasoning
// levels from a model name. Native Codex entries are preserved unchanged.
function toCodexModel(model, priority) {
  return {
    slug: model.id,
    display_name: model.id,
    description: '',
    default_reasoning_level: null,
    supported_reasoning_levels: [],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority,
    upgrade: null,
    base_instructions: '',
    supports_reasoning_summaries: false,
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    truncation_policy: { mode: 'tokens', limit: 10000 },
    supports_parallel_tool_calls: false,
    context_window: null,
    experimental_supported_tools: [],
    input_modalities: ['text']
  }
}

function normalizeModelCatalog(payload, apiKey, supportedModels = []) {
  const hasCodexModels = Array.isArray(payload?.models)
  const hasOpenAIModels = Array.isArray(payload?.data)
  if (
    (!hasCodexModels && !hasOpenAIModels) ||
    (hasCodexModels &&
      payload.models.some((model) => !model || typeof model.slug !== 'string' || !model.slug)) ||
    (hasOpenAIModels &&
      payload.data.some((model) => !model || typeof model.id !== 'string' || !model.id))
  ) {
    throw new Error('Invalid upstream model catalog')
  }

  const restricted =
    (apiKey.enableModelRestriction === true || apiKey.enableModelRestriction === 'true') &&
    Array.isArray(apiKey.restrictedModels)
      ? apiKey.restrictedModels
      : []
  const supported = Array.isArray(supportedModels) ? supportedModels : []
  const allowed = (id) =>
    !restricted.includes(id) && (supported.length === 0 || supported.includes(id))
  const models = hasCodexModels
    ? payload.models.filter((model) => allowed(model.slug))
    : payload.data.filter((model) => allowed(model.id)).map(toCodexModel)
  const data = hasOpenAIModels
    ? payload.data.filter((model) => allowed(model.id))
    : models.map((model) => ({ id: model.slug, object: 'model', created: 0, owned_by: 'openai' }))

  // Both clients can consume the same endpoint, including Codex with a /v1 base URL.
  return { ...payload, object: 'list', data, models }
}

module.exports = { normalizeModelCatalog }
