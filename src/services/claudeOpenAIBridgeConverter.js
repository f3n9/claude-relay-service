const PARAMS_TO_COPY = [
  'max_tokens',
  'temperature',
  'top_p',
  'presence_penalty',
  'frequency_penalty',
  'reasoning_effort'
]

function convertClaudeRequestToOpenAI(claudeBody = {}, targetModel) {
  const body = {
    model: targetModel,
    messages: [],
    stream: claudeBody.stream === true
  }

  const systemText = _textFromSystem(claudeBody.system)
  if (systemText) {
    body.messages.push({ role: 'system', content: systemText })
  }

  for (const message of claudeBody.messages || []) {
    body.messages.push(..._convertClaudeMessageToOpenAI(message))
  }

  if (Array.isArray(claudeBody.tools)) {
    body.tools = claudeBody.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema || {}
      }
    }))
  }

  if (claudeBody.tool_choice !== undefined) {
    body.tool_choice = _convertToolChoice(claudeBody.tool_choice)
  }

  for (const param of PARAMS_TO_COPY) {
    if (claudeBody[param] !== undefined) {
      body[param] = claudeBody[param]
    }
  }

  if (claudeBody.stop_sequences !== undefined) {
    body.stop = claudeBody.stop_sequences
  }

  return body
}

function convertOpenAIResponseToClaude(openaiResponse = {}, sourceModel) {
  const choice = (openaiResponse.choices || [])[0] || {}
  const message = choice.message || {}
  const content = []

  const text = _textFromOpenAIContent(message.content)
  if (text) {
    content.push({ type: 'text', text })
  }

  for (const toolCall of message.tool_calls || []) {
    if (toolCall?.type && toolCall.type !== 'function') {
      continue
    }

    content.push({
      type: 'tool_use',
      id: toolCall.id,
      name: toolCall.function?.name,
      input: _parseJsonObject(toolCall.function?.arguments)
    })
  }

  if (message.function_call) {
    content.push({
      type: 'tool_use',
      id: message.function_call.id || 'function_call',
      name: message.function_call.name,
      input: _parseJsonObject(message.function_call.arguments)
    })
  }

  return {
    id: openaiResponse.id,
    type: 'message',
    role: 'assistant',
    model: sourceModel,
    content,
    stop_reason: _mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: _usageFromOpenAI(openaiResponse.usage)
  }
}

function createStreamState(sourceModel) {
  return {
    sourceModel,
    messageStarted: false,
    messageId: null,
    completed: false,
    nextContentBlockIndex: 0,
    currentBlockIndex: null,
    currentBlockType: null,
    toolBlocks: new Map(),
    usage: { input_tokens: 0, output_tokens: 0 }
  }
}

function convertOpenAIStreamChunkToClaudeEvents(chunk = {}, state) {
  if (!state || state.completed) {
    return []
  }

  const events = []
  _ensureMessageStart(events, chunk, state)

  const choice = (chunk.choices || [])[0] || {}
  const delta = choice.delta || {}

  if (typeof delta.content === 'string' && delta.content.length > 0) {
    _ensureTextBlock(events, state)
    events.push({
      type: 'content_block_delta',
      index: state.currentBlockIndex,
      delta: { type: 'text_delta', text: delta.content }
    })
  }

  for (const toolCall of delta.tool_calls || []) {
    _emitToolCallDelta(events, toolCall, state)
  }

  if (choice.finish_reason) {
    _closeCurrentBlock(events, state)

    state.usage = _usageFromOpenAI(chunk.usage || choice.usage || state.usage)
    events.push({
      type: 'message_delta',
      delta: {
        stop_reason: _mapFinishReason(choice.finish_reason),
        stop_sequence: null
      },
      usage: state.usage
    })
    events.push({ type: 'message_stop' })
    state.completed = true
  }

  return events
}

function _usageFromOpenAI(usage = {}) {
  return {
    input_tokens: usage.prompt_tokens ?? usage.input_tokens ?? 0,
    output_tokens: usage.completion_tokens ?? usage.output_tokens ?? 0
  }
}

function _convertClaudeMessageToOpenAI(message = {}) {
  if (message.role === 'assistant') {
    return [_convertAssistantMessage(message)]
  }

  if (message.role === 'user') {
    return _convertUserMessage(message)
  }

  return [
    {
      role: message.role,
      content: _convertClaudeContent(message.content)
    }
  ]
}

function _convertAssistantMessage(message) {
  const blocks = Array.isArray(message.content) ? message.content : null
  if (!blocks) {
    return { role: 'assistant', content: message.content ?? null }
  }

  const textParts = []
  const toolCalls = []

  for (const block of blocks) {
    if (block?.type === 'text' && block.text) {
      textParts.push(block.text)
    } else if (block?.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        type: 'function',
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input || {})
        }
      })
    }
  }

  const openaiMessage = {
    role: 'assistant',
    content: textParts.length > 0 ? textParts.join('') : null
  }

  if (toolCalls.length > 0) {
    openaiMessage.tool_calls = toolCalls
  }

  return openaiMessage
}

function _convertUserMessage(message) {
  if (!Array.isArray(message.content)) {
    return [{ role: 'user', content: message.content ?? '' }]
  }

  const messages = []
  let regularParts = []

  const flushRegularParts = () => {
    if (regularParts.length === 0) {
      return
    }

    messages.push({
      role: 'user',
      content: _openAIContentFromParts(regularParts)
    })
    regularParts = []
  }

  for (const block of message.content) {
    if (block?.type === 'tool_result') {
      flushRegularParts()
      messages.push({
        role: 'tool',
        tool_call_id: block.tool_use_id,
        content: _textFromToolResultContent(block.content)
      })
    } else {
      regularParts.push(block)
    }
  }

  flushRegularParts()
  return messages
}

function _convertClaudeContent(content) {
  if (typeof content === 'string') {
    return content
  }

  if (!Array.isArray(content)) {
    return content ?? ''
  }

  return _openAIContentFromParts(content)
}

function _openAIContentFromParts(parts) {
  const converted = []
  let hasImage = false

  for (const part of parts) {
    if (part?.type === 'text') {
      converted.push({ type: 'text', text: part.text || '' })
    } else if (part?.type === 'image' && part.source?.type === 'base64') {
      hasImage = true
      converted.push({
        type: 'image_url',
        image_url: {
          url: `data:${part.source.media_type};base64,${part.source.data}`
        }
      })
    }
  }

  if (!hasImage) {
    return converted.map((part) => part.text).join('')
  }

  return converted
}

function _textFromSystem(system) {
  if (typeof system === 'string') {
    return system.trim()
  }

  if (!Array.isArray(system)) {
    return ''
  }

  return system
    .filter((block) => block?.type === 'text' && block.text)
    .map((block) => block.text)
    .join('\n\n')
    .trim()
}

function _textFromToolResultContent(content) {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .filter((block) => block?.type === 'text' && block.text)
      .map((block) => block.text)
      .join('')
  }

  return content === null || content === undefined ? '' : JSON.stringify(content)
}

function _textFromOpenAIContent(content) {
  if (typeof content === 'string') {
    return content
  }

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part
        }
        return part?.text || ''
      })
      .join('')
  }

  return ''
}

function _convertToolChoice(toolChoice) {
  if (typeof toolChoice === 'string') {
    if (toolChoice === 'any') {
      return 'required'
    }
    return toolChoice
  }

  if (toolChoice?.type === 'auto' || toolChoice?.type === 'none') {
    return toolChoice.type
  }

  if (toolChoice?.type === 'any') {
    return 'required'
  }

  if (toolChoice?.type === 'tool' && toolChoice.name) {
    return {
      type: 'function',
      function: { name: toolChoice.name }
    }
  }

  return toolChoice
}

function _mapFinishReason(reason) {
  if (reason === 'tool_calls' || reason === 'function_call') {
    return 'tool_use'
  }
  if (reason === 'length') {
    return 'max_tokens'
  }
  if (reason === 'content_filter') {
    return 'stop_sequence'
  }
  return 'end_turn'
}

function _parseJsonObject(value) {
  if (!value) {
    return {}
  }

  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (_) {
    return {}
  }
}

function _ensureMessageStart(events, chunk, state) {
  if (state.messageStarted) {
    return
  }

  state.messageId = chunk.id || state.messageId || `msg_${Date.now()}`
  events.push({
    type: 'message_start',
    message: {
      id: state.messageId,
      type: 'message',
      role: 'assistant',
      model: state.sourceModel,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 }
    }
  })
  state.messageStarted = true
}

function _ensureTextBlock(events, state) {
  if (state.currentBlockType === 'text') {
    return
  }

  _closeCurrentBlock(events, state)
  const index = state.nextContentBlockIndex++
  state.currentBlockIndex = index
  state.currentBlockType = 'text'
  events.push({
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '' }
  })
}

function _emitToolCallDelta(events, toolCall, state) {
  const openAIIndex = toolCall.index ?? 0
  let block = state.toolBlocks.get(openAIIndex)

  if (!block) {
    _closeCurrentBlock(events, state)

    block = {
      index: state.nextContentBlockIndex++,
      id: toolCall.id || `call_${openAIIndex}`,
      name: toolCall.function?.name || ''
    }
    state.toolBlocks.set(openAIIndex, block)
    state.currentBlockIndex = block.index
    state.currentBlockType = 'tool_use'

    events.push({
      type: 'content_block_start',
      index: block.index,
      content_block: {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: {}
      }
    })
  } else {
    if (toolCall.id) {
      block.id = toolCall.id
    }
    if (toolCall.function?.name) {
      block.name = toolCall.function.name
    }
    state.currentBlockIndex = block.index
    state.currentBlockType = 'tool_use'
  }

  const partialJson = toolCall.function?.arguments
  if (typeof partialJson === 'string' && partialJson.length > 0) {
    events.push({
      type: 'content_block_delta',
      index: block.index,
      delta: {
        type: 'input_json_delta',
        partial_json: partialJson
      }
    })
  }
}

function _closeCurrentBlock(events, state) {
  if (state.currentBlockIndex === null) {
    return
  }

  events.push({
    type: 'content_block_stop',
    index: state.currentBlockIndex
  })
  state.currentBlockIndex = null
  state.currentBlockType = null
}

module.exports = {
  convertClaudeRequestToOpenAI,
  convertOpenAIResponseToClaude,
  createStreamState,
  convertOpenAIStreamChunkToClaudeEvents,
  _usageFromOpenAI
}
