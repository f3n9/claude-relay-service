const CodexToOpenAIConverter = require('../src/services/codexToOpenAI')

function parseChunk(sseChunk) {
  const prefix = 'data: '
  expect(sseChunk.startsWith(prefix)).toBe(true)
  return JSON.parse(sseChunk.slice(prefix.length).trim())
}

describe('CodexToOpenAIConverter custom tool call input events', () => {
  it('converts response.custom_tool_call_input.delta events into tool call argument deltas', () => {
    const converter = new CodexToOpenAIConverter()
    const state = converter.createStreamState()

    converter.convertStreamChunk(
      {
        type: 'response.output_item.added',
        item: {
          type: 'custom_tool_call',
          id: 'ct_1',
          call_id: 'call_1',
          name: 'run_custom_tool'
        }
      },
      'gpt-5',
      state
    )

    const chunks = converter.convertStreamChunk(
      {
        type: 'response.custom_tool_call_input.delta',
        delta: '{"city":"San'
      },
      'gpt-5',
      state
    )

    expect(chunks).toHaveLength(1)
    const chunk = parseChunk(chunks[0])
    expect(chunk.choices[0].delta.tool_calls[0].index).toBe(0)
    expect(chunk.choices[0].delta.tool_calls[0].function.arguments).toBe('{"city":"San')
  })

  it('converts response.custom_tool_call_input.done events into full arguments when no delta arrived', () => {
    const converter = new CodexToOpenAIConverter()
    const state = converter.createStreamState()

    converter.convertStreamChunk(
      {
        type: 'response.output_item.added',
        item: {
          type: 'custom_tool_call',
          id: 'ct_2',
          call_id: 'call_2',
          name: 'run_custom_tool'
        }
      },
      'gpt-5',
      state
    )

    const chunks = converter.convertStreamChunk(
      {
        type: 'response.custom_tool_call_input.done',
        input: '{"city":"San Francisco"}'
      },
      'gpt-5',
      state
    )

    expect(chunks).toHaveLength(1)
    const chunk = parseChunk(chunks[0])
    expect(chunk.choices[0].delta.tool_calls[0].index).toBe(0)
    expect(chunk.choices[0].delta.tool_calls[0].function.arguments).toBe(
      '{"city":"San Francisco"}'
    )
  })
})
