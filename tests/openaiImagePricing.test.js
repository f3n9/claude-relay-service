jest.mock('../src/utils/logger', () => ({ debug: jest.fn(), warn: jest.fn() }))
jest.mock('../src/services/pricingService', () => ({ getModelPricing: jest.fn() }))
const calculator = require('../src/utils/costCalculator')

test.each(['gpt-image-2', 'gpt-image-2-2026-04-21'])(
  'uses official image rates for %s without downloaded pricing',
  (model) => {
    const result = calculator.calculateCost({ input_tokens: 100, output_tokens: 1000 }, model)
    expect(result.costs.input).toBeCloseTo(0.0005, 10)
    expect(result.costs.output).toBeCloseTo(0.03, 10)
    expect(result.costs.total).toBeCloseTo(0.0305, 10)
  }
)

test('splits cached text and image inputs without billing cached tokens twice', () => {
  const result = calculator.calculateCost(
    {
      input_tokens: 1000,
      output_tokens: 1000,
      input_tokens_details: {
        text_tokens: 400,
        image_tokens: 600,
        cached_tokens: 300,
        cached_tokens_details: { text_tokens: 100, image_tokens: 200 }
      }
    },
    'gpt-image-2'
  )
  expect(result.costs.input).toBeCloseTo(300 * 5e-6 + 400 * 8e-6, 10)
  expect(result.costs.cacheRead).toBeCloseTo(100 * 1.25e-6 + 200 * 2e-6, 10)
  expect(result.costs.total).toBeCloseTo(0.035225, 10)
})

test.each([
  ['gpt-image-1', 0.04],
  ['gpt-image-1-mini', 0.008],
  ['gpt-image-1.5', 0.032]
])('uses image output rate for %s', (model, cost) => {
  expect(calculator.calculateCost({ output_tokens: 1000 }, model).costs.output).toBeCloseTo(
    cost,
    10
  )
})

test('keeps text and image output prices separate', () => {
  const result = calculator.calculateCost(
    { output_tokens: 1000, output_tokens_details: { text_tokens: 100, image_tokens: 900 } },
    'gpt-image-1.5'
  )
  expect(result.costs.output).toBeCloseTo(100 * 1e-5 + 900 * 3.2e-5, 10)
})

test('aggregated text-only image usage adds cache tokens back before pricing', () => {
  const result = calculator.calculateAggregatedCost(
    { inputTokens: 80, cacheReadTokens: 20, outputTokens: 1000 },
    'gpt-image-2'
  )
  expect(result.costs.total).toBeCloseTo(80 * 5e-6 + 20 * 1.25e-6 + 1000 * 30e-6, 10)
})
