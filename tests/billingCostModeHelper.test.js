const { resolveDisplayMode, buildCostView } = require('../src/utils/billingCostModeHelper')

describe('billingCostModeHelper', () => {
  it('defaults to real mode for empty input', () => {
    expect(resolveDisplayMode(undefined)).toBe('real')
    expect(resolveDisplayMode(null)).toBe('real')
    expect(resolveDisplayMode('')).toBe('real')
  })

  it('returns rated only when explicitly set', () => {
    expect(resolveDisplayMode('rated')).toBe('rated')
    expect(resolveDisplayMode('RATED')).toBe('rated')
    expect(resolveDisplayMode('real')).toBe('real')
    expect(resolveDisplayMode('foo')).toBe('real')
  })

  it('builds display cost from real lane in real mode', () => {
    const view = buildCostView({ realCost: 3.21, ratedCost: 1.07 }, 'real')

    expect(view).toEqual({
      realCost: 3.21,
      ratedCost: 1.07,
      displayCost: 3.21,
      displayCostMode: 'real'
    })
  })

  it('builds display cost from rated lane in rated mode', () => {
    const view = buildCostView({ realCost: 3.21, ratedCost: 1.07 }, 'rated')

    expect(view).toEqual({
      realCost: 3.21,
      ratedCost: 1.07,
      displayCost: 1.07,
      displayCostMode: 'rated'
    })
  })

  it('normalizes invalid costs to zero', () => {
    const view = buildCostView({ realCost: 'x', ratedCost: null }, 'real')

    expect(view).toEqual({
      realCost: 0,
      ratedCost: 0,
      displayCost: 0,
      displayCostMode: 'real'
    })
  })
})
