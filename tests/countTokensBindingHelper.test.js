const { hasExplicitDedicatedClaudeBinding } = require('../src/routes/countTokensBindingHelper')

describe('countTokensBindingHelper', () => {
  it('treats group-prefixed Vertex bindings as non-dedicated', () => {
    const apiKey = {
      claudeVertexAccountId: 'group:vertex-group-1'
    }

    expect(hasExplicitDedicatedClaudeBinding(apiKey)).toBe(false)
  })
})
