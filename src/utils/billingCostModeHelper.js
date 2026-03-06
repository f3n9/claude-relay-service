function resolveDisplayMode(mode) {
  if (typeof mode !== 'string') {
    return 'real'
  }

  const normalized = mode.trim().toLowerCase()
  return normalized === 'rated' ? 'rated' : 'real'
}

function normalizeCost(value) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function buildCostView(costs = {}, mode) {
  const displayCostMode = resolveDisplayMode(mode)
  const realCost = normalizeCost(costs.realCost)
  const ratedCost = normalizeCost(costs.ratedCost)
  const displayCost = displayCostMode === 'rated' ? ratedCost : realCost

  return {
    realCost,
    ratedCost,
    displayCost,
    displayCostMode
  }
}

module.exports = {
  resolveDisplayMode,
  buildCostView
}
