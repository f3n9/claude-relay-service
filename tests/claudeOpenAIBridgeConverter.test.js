const {
  convertClaudeRequestToOpenAI,
  convertOpenAIResponseToClaude,
  createStreamState,
  convertOpenAIStreamChunkToClaudeEvents
} = require('../src/services/claudeOpenAIBridgeConverter')

describe('claudeOpenAIBridgeConverter', () => {
  it('converts Claude requests to OpenAI chat completions requests', () => {
    const result = convertClaudeRequestToOpenAI(
      {
        model: 'claude-sonnet-4-bridge',
        system: [
          { type: 'text', text: 'You are concise.' },
          { type: 'text', text: 'Prefer JSON.' }
        ],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Describe this image.' },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgo='
                }
              }
            ]
          },
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will call the weather tool.' },
              {
                type: 'tool_use',
                id: 'toolu_123',
                name: 'get_weather',
                input: { city: 'Shanghai' }
              }
            ]
          },
          {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'toolu_123',
                content: [{ type: 'text', text: '{"temperature":26}' }]
              },
              { type: 'text', text: 'Summarize it.' }
            ]
          }
        ],
        tools: [
          {
            name: 'get_weather',
            description: 'Read current weather',
            input_schema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city']
            }
          }
        ],
        tool_choice: { type: 'tool', name: 'get_weather' },
        max_tokens: 1024,
        temperature: 0.2,
        top_p: 0.9,
        presence_penalty: 0.1,
        frequency_penalty: 0.2,
        reasoning_effort: 'medium',
        stop_sequences: ['\n\nHuman:'],
        stream: false
      },
      'gpt-4.1-mini'
    )

    expect(result).toEqual({
      model: 'gpt-4.1-mini',
      messages: [
        { role: 'system', content: 'You are concise.\n\nPrefer JSON.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' }
            }
          ]
        },
        {
          role: 'assistant',
          content: 'I will call the weather tool.',
          tool_calls: [
            {
              id: 'toolu_123',
              type: 'function',
              function: {
                name: 'get_weather',
                arguments: '{"city":"Shanghai"}'
              }
            }
          ]
        },
        {
          role: 'tool',
          tool_call_id: 'toolu_123',
          content: '{"temperature":26}'
        },
        {
          role: 'user',
          content: 'Summarize it.'
        }
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'get_weather',
            description: 'Read current weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city']
            }
          }
        }
      ],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
      max_tokens: 1024,
      temperature: 0.2,
      top_p: 0.9,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      reasoning_effort: 'medium',
      stop: ['\n\nHuman:'],
      stream: false
    })
  })

  it('converts OpenAI non-stream text and tool calls to Claude response shape', () => {
    const result = convertOpenAIResponseToClaude(
      {
        id: 'chatcmpl_123',
        model: 'gpt-4.1-mini',
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'I need weather data.',
              tool_calls: [
                {
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Shanghai"}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4
        }
      },
      'claude-sonnet-4-bridge'
    )

    expect(result).toEqual({
      id: 'chatcmpl_123',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-bridge',
      content: [
        { type: 'text', text: 'I need weather data.' },
        {
          type: 'tool_use',
          id: 'call_123',
          name: 'get_weather',
          input: { city: 'Shanghai' }
        }
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 12,
        output_tokens: 4
      }
    })
  })

  it('maps Claude object-form tool choices to OpenAI tool choices', () => {
    expect(
      convertClaudeRequestToOpenAI({ tool_choice: { type: 'auto' } }, 'gpt-4.1').tool_choice
    ).toBe('auto')
    expect(
      convertClaudeRequestToOpenAI({ tool_choice: { type: 'none' } }, 'gpt-4.1').tool_choice
    ).toBe('none')
    expect(
      convertClaudeRequestToOpenAI({ tool_choice: { type: 'any' } }, 'gpt-4.1').tool_choice
    ).toBe('required')
  })

  it('falls back to empty tool input for malformed JSON and supports legacy function_call', () => {
    const result = convertOpenAIResponseToClaude(
      {
        id: 'chatcmpl_legacy',
        choices: [
          {
            message: {
              role: 'assistant',
              content: '',
              function_call: {
                name: 'legacy_tool',
                arguments: '{"unterminated"'
              }
            },
            finish_reason: 'function_call'
          }
        ],
        usage: {
          input_tokens: 7,
          output_tokens: 2
        }
      },
      'claude-haiku-bridge'
    )

    expect(result).toMatchObject({
      id: 'chatcmpl_legacy',
      type: 'message',
      role: 'assistant',
      model: 'claude-haiku-bridge',
      content: [
        {
          type: 'tool_use',
          id: 'function_call',
          name: 'legacy_tool',
          input: {}
        }
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: {
        input_tokens: 7,
        output_tokens: 2
      }
    })
  })

  it('converts OpenAI stream text chunks to Claude events', () => {
    const state = createStreamState('claude-sonnet-4-bridge')

    const firstEvents = convertOpenAIStreamChunkToClaudeEvents(
      {
        id: 'chatcmpl_stream',
        choices: [{ delta: { role: 'assistant' }, finish_reason: null }]
      },
      state
    )
    const textEvents = convertOpenAIStreamChunkToClaudeEvents(
      {
        choices: [{ delta: { content: 'Hello' }, finish_reason: null }]
      },
      state
    )
    const finalEvents = convertOpenAIStreamChunkToClaudeEvents(
      {
        choices: [{ delta: {}, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 1
        }
      },
      state
    )

    expect(firstEvents).toEqual([
      {
        type: 'message_start',
        message: {
          id: 'chatcmpl_stream',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-bridge',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }
    ])
    expect(textEvents).toEqual([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' }
      }
    ])
    expect(finalEvents).toEqual([
      {
        type: 'content_block_stop',
        index: 0
      },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null
        },
        usage: {
          input_tokens: 5,
          output_tokens: 1
        }
      },
      { type: 'message_stop' }
    ])
    expect(state.completed).toBe(true)
  })

  it('updates state usage from post-completion usage-only stream chunks without events', () => {
    const state = createStreamState('claude-sonnet-4-bridge')

    convertOpenAIStreamChunkToClaudeEvents(
      {
        id: 'chatcmpl_usage_late',
        choices: [{ delta: { content: 'Done' }, finish_reason: null }]
      },
      state
    )
    const finishEvents = convertOpenAIStreamChunkToClaudeEvents(
      {
        choices: [{ delta: {}, finish_reason: 'stop' }]
      },
      state
    )
    const usageEvents = convertOpenAIStreamChunkToClaudeEvents(
      {
        choices: [],
        usage: {
          prompt_tokens: 21,
          completion_tokens: 8
        }
      },
      state
    )

    expect(finishEvents).toEqual([
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'end_turn',
          stop_sequence: null
        },
        usage: {
          input_tokens: 0,
          output_tokens: 0
        }
      },
      { type: 'message_stop' }
    ])
    expect(usageEvents).toEqual([])
    expect(state.completed).toBe(true)
    expect(state.usage).toEqual({
      input_tokens: 21,
      output_tokens: 8
    })
  })

  it('converts OpenAI stream tool call deltas to Claude tool_use events', () => {
    const state = createStreamState('claude-sonnet-4-bridge')

    const events = convertOpenAIStreamChunkToClaudeEvents(
      {
        id: 'chatcmpl_tools',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_123',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Shang'
                  }
                }
              ]
            },
            finish_reason: null
          }
        ]
      },
      state
    )
    const moreEvents = convertOpenAIStreamChunkToClaudeEvents(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  function: {
                    arguments: 'hai"}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ],
        usage: {
          prompt_tokens: 9,
          completion_tokens: 3
        }
      },
      state
    )

    expect(events).toEqual([
      {
        type: 'message_start',
        message: {
          id: 'chatcmpl_tools',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-bridge',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }
    ])
    expect(moreEvents).toEqual([
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_123',
          name: 'get_weather',
          input: {}
        }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"city":"Shanghai"}'
        }
      },
      {
        type: 'content_block_stop',
        index: 0
      },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'tool_use',
          stop_sequence: null
        },
        usage: {
          input_tokens: 9,
          output_tokens: 3
        }
      },
      { type: 'message_stop' }
    ])
  })

  it('buffers interleaved OpenAI stream tool calls and emits valid sequential Claude blocks at finish', () => {
    const state = createStreamState('claude-sonnet-4-bridge')

    const firstEvents = convertOpenAIStreamChunkToClaudeEvents(
      {
        id: 'chatcmpl_parallel_tools',
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_weather',
                  type: 'function',
                  function: {
                    name: 'get_weather',
                    arguments: '{"city":"Shang'
                  }
                }
              ]
            },
            finish_reason: null
          }
        ]
      },
      state
    )
    const secondEvents = convertOpenAIStreamChunkToClaudeEvents(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  id: 'call_time',
                  type: 'function',
                  function: {
                    name: 'get_time',
                    arguments: '{"zone":"Asia'
                  }
                },
                {
                  index: 0,
                  function: {
                    arguments: 'hai"}'
                  }
                }
              ]
            },
            finish_reason: null
          }
        ]
      },
      state
    )
    const finalEvents = convertOpenAIStreamChunkToClaudeEvents(
      {
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 1,
                  function: {
                    arguments: '/Shanghai"}'
                  }
                }
              ]
            },
            finish_reason: 'tool_calls'
          }
        ]
      },
      state
    )

    expect(firstEvents).toEqual([
      {
        type: 'message_start',
        message: {
          id: 'chatcmpl_parallel_tools',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-4-bridge',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 }
        }
      }
    ])
    expect(secondEvents).toEqual([])
    expect(finalEvents).toEqual([
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'call_weather',
          name: 'get_weather',
          input: {}
        }
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"city":"Shanghai"}'
        }
      },
      {
        type: 'content_block_stop',
        index: 0
      },
      {
        type: 'content_block_start',
        index: 1,
        content_block: {
          type: 'tool_use',
          id: 'call_time',
          name: 'get_time',
          input: {}
        }
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: {
          type: 'input_json_delta',
          partial_json: '{"zone":"Asia/Shanghai"}'
        }
      },
      {
        type: 'content_block_stop',
        index: 1
      },
      {
        type: 'message_delta',
        delta: {
          stop_reason: 'tool_use',
          stop_sequence: null
        },
        usage: {
          input_tokens: 0,
          output_tokens: 0
        }
      },
      { type: 'message_stop' }
    ])
  })
})
