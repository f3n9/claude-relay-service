// Public model-page snapshot checked 2026-09-18; sources are in docs/openai-models.md.
// GPT-6 Sol/Luna input and output checked 2026-09-23.
// Only exact documented IDs/aliases/snapshots qualify. Azure deployment names alone
// do not establish capabilities, and input_file is a content type, not a modality.
const visionModels = new Set([
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-6-astra',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.6',
  'gpt-5.5',
  'gpt-5.5-2026-04-23',
  'gpt-5.4',
  'gpt-5.4-2026-03-05',
  'gpt-5.3-codex',
  'gpt-image-2',
  'gpt-image-2-2026-04-21',
  'gpt-5',
  'gpt-5-2025-08-07',
  'gpt-5-mini',
  'gpt-5-mini-2025-08-07',
  'gpt-5-nano',
  'gpt-5-nano-2025-08-07',
  'gpt-5.1',
  'gpt-5.1-2025-11-13',
  'gpt-5.2',
  'gpt-5.2-2025-12-11',
  'gpt-4.1',
  'gpt-4.1-2025-04-14',
  'gpt-4.1-mini',
  'gpt-4.1-mini-2025-04-14',
  'gpt-4.1-nano',
  'gpt-4.1-nano-2025-04-14',
  'gpt-4o',
  'gpt-4o-2024-11-20',
  'gpt-4o-2024-08-06',
  'gpt-4o-2024-05-13',
  'gpt-4o-mini',
  'gpt-4o-mini-2024-07-18'
])
const audioModels = new Set([
  'gpt-audio',
  'gpt-audio-2025-08-28',
  'gpt-audio-mini',
  'gpt-audio-mini-2025-10-06',
  'gpt-audio-mini-2025-12-15'
])
const realtimeModels = new Set([
  'gpt-realtime',
  'gpt-realtime-2025-08-28',
  'gpt-realtime-mini',
  'gpt-realtime-mini-2025-10-06',
  'gpt-realtime-mini-2025-12-15'
])
// Output profiles are added only for models whose output has been verified here.
const textOutputModels = new Set(['gpt-6-sol', 'gpt-6-luna'])

function getModelInputModalities(modelId, upstream = {}) {
  // Provider metadata may describe a narrower deployment or a custom audio model.
  // Preserve explicit arrays (including []) instead of replacing them with defaults.
  if (Array.isArray(upstream.input_modalities)) {
    return [...upstream.input_modalities]
  }
  if (visionModels.has(modelId)) {
    return ['text', 'image']
  }
  if (audioModels.has(modelId)) {
    return ['text', 'audio']
  }
  if (realtimeModels.has(modelId)) {
    return ['text', 'image', 'audio']
  }
  return undefined
}

function getModelOutputModalities(modelId, upstream = {}) {
  if (Array.isArray(upstream.output_modalities)) {
    return [...upstream.output_modalities]
  }
  return textOutputModels.has(modelId) ? ['text'] : undefined
}

function supplementModelModalities(model) {
  const input = getModelInputModalities(model.slug, model)
  const output = getModelOutputModalities(model.slug, model)
  // Keep legacy native-catalog defaults for unrecognized models with no metadata.
  return {
    ...model,
    ...(input === undefined ? {} : { input_modalities: input }),
    ...(output === undefined ? {} : { output_modalities: output })
  }
}

module.exports = { getModelInputModalities, getModelOutputModalities, supplementModelModalities }
