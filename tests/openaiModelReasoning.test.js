const { normalizeModelCatalog } = require('../src/utils/openaiModelCatalog')

const supported = (model) => model.supported_reasoning_levels.map((level) => level.effort)
const fromStandard = (id) => normalizeModelCatalog({ data: [{ id }] }, {}).models[0]

test.each([
  ['gpt-6-astra', ['low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
  ['gpt-5.6-sol', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
  ['gpt-5.6-terra', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
  ['gpt-5.6-luna', ['none', 'low', 'medium', 'high', 'xhigh', 'max'], 'medium'],
  ['gpt-5.5', ['none', 'low', 'medium', 'high', 'xhigh'], 'medium'],
  ['gpt-5.4', ['none', 'low', 'medium', 'high', 'xhigh'], 'none'],
  ['gpt-5.3-codex', ['low', 'medium', 'high', 'xhigh'], 'medium']
])('supplements standard model %s with documented efforts', (id, efforts, defaultEffort) => {
  const model = fromStandard(id)
  expect(supported(model)).toEqual(efforts)
  expect(model.default_reasoning_level).toBe(defaultEffort)
  expect(
    model.supported_reasoning_levels.every(
      (level) => typeof level.description === 'string' && level.description.length
    )
  ).toBe(true)
  expect(model.slug).toBe(id)
})

test.each(['custom-deployment', 'gpt-5.6-sol-custom', 'gpt-5.4-mini', 'gpt-5.5-pro'])(
  'uses a conservative medium fallback for unmatched %s',
  (id) => {
    expect(supported(fromStandard(id))).toEqual(['medium'])
    expect(fromStandard(id).default_reasoning_level).toBe('medium')
  }
)

test('does not alter the standard model list or fabricate models', () => {
  const payload = { data: [{ id: 'gpt-5.4', owned_by: 'azure' }] }
  const original = JSON.parse(JSON.stringify(payload))
  const result = normalizeModelCatalog(payload, {})
  expect(result.data).toEqual(original.data)
  expect(payload).toEqual(original)
  expect(result.models).toHaveLength(1)
  expect(normalizeModelCatalog({ data: [] }, {}).models).toEqual([])
})

test('preserves native upstream reasoning, descriptions and all other capabilities', () => {
  const model = {
    slug: 'gpt-5.4',
    default_reasoning_level: 'high',
    supported_reasoning_levels: [{ effort: 'high', description: 'Provider-specific' }],
    context_window: 123,
    supports_reasoning_summaries: true
  }
  const result = normalizeModelCatalog({ models: [model] }, {})
  expect(result.models).toEqual([model])
  expect(model.default_reasoning_level).toBe('high')
})

test('respects explicitly empty upstream support instead of enabling reasoning', () => {
  const model = { slug: 'gpt-5.4', default_reasoning_level: null, supported_reasoning_levels: [] }
  expect(normalizeModelCatalog({ models: [model] }, {}).models).toEqual([model])
})

test('fills missing native fields without replacing existing fields', () => {
  const model = { slug: 'gpt-5.6-sol', context_window: 123 }
  const result = normalizeModelCatalog({ models: [model] }, {}).models[0]
  expect(result.default_reasoning_level).toBe('medium')
  expect(supported(result)).toEqual(['none', 'low', 'medium', 'high', 'xhigh', 'max'])
  expect(result.context_window).toBe(123)
  expect(model).toEqual({ slug: 'gpt-5.6-sol', context_window: 123 })
})

test('chooses a default within an upstream supported set when default is missing', () => {
  const result = normalizeModelCatalog(
    {
      models: [
        { slug: 'gpt-5.4', supported_reasoning_levels: [{ effort: 'high', description: 'High' }] }
      ]
    },
    {}
  ).models[0]
  expect(result.default_reasoning_level).toBe('high')
  expect(supported(result)).toEqual(['high'])
})

test('preserves an upstream default when only the supported set is missing', () => {
  const result = normalizeModelCatalog(
    { models: [{ slug: 'custom', default_reasoning_level: 'low' }] },
    {}
  ).models[0]
  expect(result.default_reasoning_level).toBe('low')
  expect(supported(result)).toEqual(['low'])
})

test('preserves the key and account display filters', () => {
  const result = normalizeModelCatalog(
    { data: ['gpt-5.6-sol', 'gpt-5.6-luna', 'gpt-5.5'].map((id) => ({ id })) },
    { enableModelRestriction: true, restrictedModels: ['gpt-5.6-luna'] },
    [],
    ['gpt-5.6-*']
  )
  expect(result.models.map((model) => model.slug)).toEqual(['gpt-5.6-sol'])
  expect(result.models[0].default_reasoning_level).toBe('medium')
})

test('preserves explicit upstream null when the supported set is absent', () => {
  const result = normalizeModelCatalog(
    { models: [{ slug: 'gpt-5.4', default_reasoning_level: null }] },
    {}
  ).models[0]
  expect(result.default_reasoning_level).toBeNull()
  expect(supported(result)).toEqual([])
})

test('retains reasoning extensions already supplied on a standard model entry', () => {
  const model = {
    id: 'gpt-5.6-sol',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [{ effort: 'low', description: 'Azure deployment setting' }]
  }
  const result = normalizeModelCatalog({ data: [model] }, {})
  expect(result.models[0].default_reasoning_level).toBe('low')
  expect(result.models[0].supported_reasoning_levels).toEqual(model.supported_reasoning_levels)
  expect(result.data).toEqual([model])
})

test.each(['data', 'models'])(
  'gpt-image-2 has no advertised reasoning efforts in %s catalogs',
  (format) => {
    const entry = format === 'data' ? { id: 'gpt-image-2' } : { slug: 'gpt-image-2' }
    const result = normalizeModelCatalog({ [format]: [entry] }, {})
    expect(result.models[0].default_reasoning_level).toBeNull()
    expect(supported(result.models[0])).toEqual([])
    expect(result.models[0].slug).toBe('gpt-image-2')
    expect(result.data[0].id).toBe('gpt-image-2')
  }
)

test('gpt-image-2 still preserves explicit provider reasoning metadata', () => {
  const entry = {
    slug: 'gpt-image-2',
    default_reasoning_level: 'low',
    supported_reasoning_levels: [{ effort: 'low', description: 'Provider extension' }]
  }
  expect(normalizeModelCatalog({ models: [entry] }, {}).models).toEqual([entry])
})
