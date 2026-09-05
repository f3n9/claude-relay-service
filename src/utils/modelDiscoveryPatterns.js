// This allowlist controls model discovery only; it does not change scheduling or inference.
function normalizeModelDiscoveryPatterns(value = []) {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((pattern) => typeof pattern !== 'string' || pattern.trim().length > 200)
  ) {
    throw new Error(
      'modelDiscoveryPatterns must be an array of up to 100 strings (200 characters each)'
    )
  }
  return [...new Set(value.map((pattern) => pattern.trim()).filter(Boolean))]
}

function readModelDiscoveryPatterns(value) {
  return normalizeModelDiscoveryPatterns(typeof value === 'string' ? JSON.parse(value) : value)
}

// Match literal segments in order rather than building a user-controlled regexp.
function matchesModelDiscoveryPatterns(model, patterns) {
  return (
    patterns.length === 0 ||
    patterns.some((pattern) => {
      const parts = pattern.split('*')
      if (parts.length === 1) {
        return model === pattern
      }
      if (!model.startsWith(parts[0])) {
        return false
      }
      let offset = parts[0].length
      for (const part of parts.slice(1, -1)) {
        const index = model.indexOf(part, offset)
        if (index === -1) {
          return false
        }
        offset = index + part.length
      }
      const suffix = parts[parts.length - 1]
      return model.length - suffix.length >= offset && model.endsWith(suffix)
    })
  )
}

function validateModelDiscoveryPatterns(req, res, next) {
  try {
    if (req.body?.modelDiscoveryPatterns !== undefined) {
      req.body.modelDiscoveryPatterns = normalizeModelDiscoveryPatterns(
        req.body.modelDiscoveryPatterns
      )
    }
    next()
  } catch (error) {
    res.status(400).json({ success: false, error: error.message })
  }
}

module.exports = {
  normalizeModelDiscoveryPatterns,
  readModelDiscoveryPatterns,
  matchesModelDiscoveryPatterns,
  validateModelDiscoveryPatterns
}
