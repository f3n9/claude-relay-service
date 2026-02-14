const {
  hasExplicitDedicatedClaudeBinding,
  getCountTokensFallbackGroupId
} = require('../src/routes/countTokensBindingHelper')

describe('countTokensBindingHelper', () => {
  it('treats group-prefixed Vertex bindings as non-dedicated', () => {
    const apiKey = {
      claudeVertexAccountId: 'group:vertex-group-1'
    }

    expect(hasExplicitDedicatedClaudeBinding(apiKey)).toBe(false)
  })

  it('extracts fallback group id from Vertex group bindings', () => {
    const apiKey = {
      claudeVertexAccountId: 'group:vertex-group-1'
    }

    expect(getCountTokensFallbackGroupId(apiKey)).toBe('vertex-group-1')
  })
})
