const { normalizeModelCatalog } = require('../src/utils/openaiModelCatalog')
const {
  normalizeModelDiscoveryPatterns,
  matchesModelDiscoveryPatterns
} = require('../src/utils/modelDiscoveryPatterns')

test('normalizes whitespace, duplicates and empty configuration', () => {
  expect(normalizeModelDiscoveryPatterns([' gpt-5 ', '', 'gpt-5'])).toEqual(['gpt-5'])
  expect(normalizeModelDiscoveryPatterns(undefined)).toEqual([])
  expect(normalizeModelDiscoveryPatterns([])).toEqual([])
})

test.each([{}, 'gpt-5', [3], ['a'.repeat(201)], Array(101).fill('gpt-5')])(
  'rejects invalid config %j',
  (value) => {
    expect(() => normalizeModelDiscoveryPatterns(value)).toThrow()
  }
)

test('matches complete IDs, with only star acting as a wildcard', () => {
  const match = (id, patterns) => matchesModelDiscoveryPatterns(id, patterns)
  expect(match('gpt-5', ['gpt-5'])).toBe(true)
  expect(match('gpt-5.1', ['gpt-5'])).toBe(false)
  expect(match('gpt-5.6-mini', ['gpt-5.6-*'])).toBe(true)
  expect(match('gpt-5x6-mini', ['gpt-5.6-*'])).toBe(false)
  expect(match('prefix-gpt-5.6-mini', ['gpt-5.6-*'])).toBe(false)
  expect(match('gpt-5.6', ['gpt-5.6-*'])).toBe(false)
  expect(match('model+[test]', ['model+[test]'])).toBe(true)
  expect(match('modeltest', ['model+[test]'])).toBe(false)
  expect(match('anything', [])).toBe(true)
  expect(match('anything', ['*'])).toBe(true)
  expect(match('GPT-5', ['gpt-5'])).toBe(false)
})

test.each(['models', 'data'])('filters %s before generating the alternate format', (format) => {
  const ids = ['gpt-5', 'gpt-5.1', 'gpt-5.6-mini', 'gpt-5.6-pro', 'gpt-4o']
  const payload = {
    [format]: ids.map((id) => (format === 'models' ? { slug: id, context_window: 123 } : { id }))
  }
  const key = { enableModelRestriction: true, restrictedModels: ['gpt-5.6-pro'] }
  const result = normalizeModelCatalog(payload, key, [], ['gpt-5', 'gpt-5.6-*'])
  expect(result.models.map((model) => model.slug)).toEqual(['gpt-5', 'gpt-5.6-mini'])
  expect(result.data.map((model) => model.id)).toEqual(['gpt-5', 'gpt-5.6-mini'])
  if (format === 'models') {
    expect(result.models[0].context_window).toBe(123)
  }
  expect(normalizeModelCatalog(payload, {}, [], ['missing']).models).toEqual([])
  expect(normalizeModelCatalog(payload, {}, [], []).models).toHaveLength(ids.length)
})
