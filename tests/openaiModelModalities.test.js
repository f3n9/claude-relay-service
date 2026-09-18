const { normalizeModelCatalog } = require('../src/utils/openaiModelCatalog')

const visionModels = [
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
]
const audioModels = [
  ['gpt-audio', ['text', 'audio']],
  ['gpt-audio-2025-08-28', ['text', 'audio']],
  ['gpt-audio-mini', ['text', 'audio']],
  ['gpt-audio-mini-2025-10-06', ['text', 'audio']],
  ['gpt-audio-mini-2025-12-15', ['text', 'audio']],
  ['gpt-realtime', ['text', 'image', 'audio']],
  ['gpt-realtime-2025-08-28', ['text', 'image', 'audio']],
  ['gpt-realtime-mini', ['text', 'image', 'audio']],
  ['gpt-realtime-mini-2025-10-06', ['text', 'image', 'audio']],
  ['gpt-realtime-mini-2025-12-15', ['text', 'image', 'audio']]
]

const catalog = (id, fields = {}, format = 'data') =>
  normalizeModelCatalog({ [format]: [{ [format === 'data' ? 'id' : 'slug']: id, ...fields }] }, {})

test.each(visionModels)('declares documented text/image input for %s', (id) => {
  for (const format of ['data', 'models']) {
    expect(catalog(id, {}, format).models[0].input_modalities).toEqual(['text', 'image'])
  }
})

test.each(audioModels)('declares audio only on documented audio model %s', (id, modalities) => {
  for (const format of ['data', 'models']) {
    expect(catalog(id, {}, format).models[0].input_modalities).toEqual(modalities)
  }
})

test.each(['data', 'models'])(
  'preserves upstream modality restrictions and extensions in %s',
  (format) => {
    for (const input_modalities of [[], ['text'], ['text', 'audio'], ['text', 'image', 'audio']]) {
      const result = catalog('gpt-5.6-sol', { input_modalities }, format)
      expect(result.models[0].input_modalities).toEqual(input_modalities)
    }
    const result = catalog(
      'custom-audio-deployment',
      { input_modalities: ['text', 'audio'] },
      format
    )
    expect(result.models[0].input_modalities).toEqual(['text', 'audio'])
  }
)

test.each([
  'custom-deployment',
  'gpt-5.6-sol-custom',
  'gpt-5.5-2099-01-01',
  'text-embedding-3-small'
])('does not guess multimodal support for %s', (id) => {
  expect(catalog(id).models[0].input_modalities).toEqual(['text'])
  // Native Codex catalogs without the field retain their existing client-default behavior.
  expect(catalog(id, {}, 'models').models[0]).not.toHaveProperty('input_modalities')
})

test('keeps model IDs, upstream data and unrelated native metadata intact', () => {
  const original = {
    models: [
      {
        slug: 'gpt-5.6-sol',
        context_window: 500000,
        supported_reasoning_levels: [],
        default_reasoning_level: null
      }
    ],
    data: [{ id: 'gpt-5.6-sol', owned_by: 'azure' }]
  }
  const payload = JSON.parse(JSON.stringify(original))
  const result = normalizeModelCatalog(payload, {})
  expect(result.models[0]).toEqual({ ...original.models[0], input_modalities: ['text', 'image'] })
  expect(result.data).toEqual(original.data)
  expect(payload).toEqual(original)
})

test('keeps filters effective and does not invent file/video modalities or extra models', () => {
  const payload = {
    data: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-4o', 'gpt-audio'].map((id) => ({ id }))
  }
  const result = normalizeModelCatalog(
    payload,
    { enableModelRestriction: true, restrictedModels: ['gpt-5.6-luna'] },
    [],
    ['gpt-5.6-*']
  )
  expect(result.models.map((model) => model.slug)).toEqual(['gpt-5.6-sol'])
  expect(result.models[0].input_modalities).toEqual(['text', 'image'])
  expect(normalizeModelCatalog({ data: [] }, {}).models).toEqual([])
})

test('returned arrays cannot modify subsequent catalog defaults', () => {
  const first = catalog('gpt-5.6-sol')
  first.models[0].input_modalities.push('audio')
  expect(catalog('gpt-5.6-sol').models[0].input_modalities).toEqual(['text', 'image'])
})
