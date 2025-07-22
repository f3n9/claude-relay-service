/**
 * OpenAI 到 Claude 格式转换服务
 * 处理 OpenAI API 格式与 Claude API 格式之间的转换
 */

const logger = require('../utils/logger');

class OpenAIToClaudeConverter {
  constructor() {
    // 停止原因映射
    this.stopReasonMapping = {
      'end_turn': 'stop',
      'max_tokens': 'length',
      'stop_sequence': 'stop',
      'tool_use': 'tool_calls'
    };
  }

  /**
   * 将 OpenAI 请求格式转换为 Claude 格式
   * @param {Object} openaiRequest - OpenAI 格式的请求
   * @returns {Object} Claude 格式的请求
   */
  convertRequest(openaiRequest) {
    const claudeRequest = {
      model: openaiRequest.model, // 直接使用提供的模型名，不进行映射
      messages: this._convertMessages(openaiRequest.messages),
      max_tokens: openaiRequest.max_tokens || 4096,
      temperature: openaiRequest.temperature,
      top_p: openaiRequest.top_p,
      stream: openaiRequest.stream || false
    };

    // Claude Code 必需的系统消息
    const claudeCodeSystemMessage = 'You are Claude Code, Anthropic\'s official CLI for Claude.';
    
    claudeRequest.system = claudeCodeSystemMessage;

    // 处理停止序列
    if (openaiRequest.stop) {
      claudeRequest.stop_sequences = Array.isArray(openaiRequest.stop) 
        ? openaiRequest.stop 
        : [openaiRequest.stop];
    }

    // 处理工具调用
    if (openaiRequest.tools) {
      claudeRequest.tools = this._convertTools(openaiRequest.tools);
      if (openaiRequest.tool_choice) {
        claudeRequest.tool_choice = this._convertToolChoice(openaiRequest.tool_choice);
      }
    }

    // OpenAI 特有的参数已在转换过程中被忽略
    // 包括: n, presence_penalty, frequency_penalty, logit_bias, user
    
    logger.debug('📝 Converted OpenAI request to Claude format:', {
      model: claudeRequest.model,
      messageCount: claudeRequest.messages.length,
      hasSystem: !!claudeRequest.system,
      stream: claudeRequest.stream
    });

    return claudeRequest;
  }

  /**
   * 将 Claude 响应格式转换为 OpenAI 格式
   * @param {Object} claudeResponse - Claude 格式的响应
   * @param {String} requestModel - 原始请求的模型名
   * @returns {Object} OpenAI 格式的响应
   */
  convertResponse(claudeResponse, requestModel) {
    const timestamp = Math.floor(Date.now() / 1000);
    
    const openaiResponse = {
      id: `chatcmpl-${this._generateId()}`,
      object: 'chat.completion',
      created: timestamp,
      model: requestModel || 'gpt-4',
      choices: [{
        index: 0,
        message: this._convertClaudeMessage(claudeResponse),
        finish_reason: this._mapStopReason(claudeResponse.stop_reason)
      }],
      usage: this._convertUsage(claudeResponse.usage)
    };

    logger.debug('📝 Converted Claude response to OpenAI format:', {
      responseId: openaiResponse.id,
      finishReason: openaiResponse.choices[0].finish_reason,
      usage: openaiResponse.usage
    });

    return openaiResponse;
  }

  /**
   * 转换流式响应的单个数据块
   * @param {String} chunk - Claude SSE 数据块
   * @param {String} requestModel - 原始请求的模型名
   * @returns {String} OpenAI 格式的 SSE 数据块
   */
  convertStreamChunk(chunk, requestModel) {
    if (!chunk || chunk.trim() === '') return '';
    
    // 解析 SSE 数据
    const lines = chunk.split('\n');
    let convertedChunks = [];

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        const data = line.substring(6);
        if (data === '[DONE]') {
          convertedChunks.push('data: [DONE]\n\n');
          continue;
        }

        try {
          const claudeEvent = JSON.parse(data);
          const openaiChunk = this._convertStreamEvent(claudeEvent, requestModel);
          if (openaiChunk) {
            convertedChunks.push(`data: ${JSON.stringify(openaiChunk)}\n\n`);
          }
        } catch (e) {
          // 如果不是 JSON，原样传递
          convertedChunks.push(line + '\n');
        }
      } else if (line.startsWith('event:') || line === '') {
        // 保留事件类型行和空行
        convertedChunks.push(line + '\n');
      }
    }

    return convertedChunks.join('');
  }


  /**
   * 提取系统消息
   */
  _extractSystemMessage(messages) {
    const systemMessages = messages.filter(msg => msg.role === 'system');
    if (systemMessages.length === 0) return null;
    
    // 合并所有系统消息
    return systemMessages.map(msg => msg.content).join('\n\n');
  }

  /**
   * 转换消息格式
   */
  _convertMessages(messages) {
    const claudeMessages = [];
    
    for (const msg of messages) {
      // 跳过系统消息（已经在 system 字段处理）
      if (msg.role === 'system') continue;
      
      // 转换角色名称
      const role = msg.role === 'user' ? 'user' : 'assistant';
      
      // 转换消息内容
      let content;
      if (typeof msg.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        // 处理多模态内容
        content = this._convertMultimodalContent(msg.content);
      } else {
        content = JSON.stringify(msg.content);
      }
      
      const claudeMsg = {
        role: role,
        content: content
      };
      
      // 处理工具调用
      if (msg.tool_calls) {
        claudeMsg.content = this._convertToolCalls(msg.tool_calls);
      }
      
      // 处理工具响应
      if (msg.role === 'tool') {
        claudeMsg.role = 'user';
        claudeMsg.content = [{
          type: 'tool_result',
          tool_use_id: msg.tool_call_id,
          content: msg.content
        }];
      }
      
      claudeMessages.push(claudeMsg);
    }
    
    return claudeMessages;
  }

  /**
   * 转换多模态内容
   */
  _convertMultimodalContent(content) {
    return content.map(item => {
      if (item.type === 'text') {
        return {
          type: 'text',
          text: item.text
        };
      } else if (item.type === 'image_url') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/jpeg', // 默认类型
            data: item.image_url.url.split(',')[1] // 假设是 base64
          }
        };
      }
      return item;
    });
  }

  /**
   * 转换工具定义
   */
  _convertTools(tools) {
    return tools.map(tool => {
      if (tool.type === 'function') {
        return {
          name: tool.function.name,
          description: tool.function.description,
          input_schema: tool.function.parameters
        };
      }
      return tool;
    });
  }

  /**
   * 转换工具选择
   */
  _convertToolChoice(toolChoice) {
    if (toolChoice === 'none') return { type: 'none' };
    if (toolChoice === 'auto') return { type: 'auto' };
    if (toolChoice === 'required') return { type: 'any' };
    if (toolChoice.type === 'function') {
      return {
        type: 'tool',
        name: toolChoice.function.name
      };
    }
    return { type: 'auto' };
  }

  /**
   * 转换工具调用
   */
  _convertToolCalls(toolCalls) {
    return toolCalls.map(tc => ({
      type: 'tool_use',
      id: tc.id,
      name: tc.function.name,
      input: JSON.parse(tc.function.arguments)
    }));
  }

  /**
   * 转换 Claude 消息为 OpenAI 格式
   */
  _convertClaudeMessage(claudeResponse) {
    const message = {
      role: 'assistant',
      content: null
    };

    // 处理内容
    if (claudeResponse.content) {
      if (typeof claudeResponse.content === 'string') {
        message.content = claudeResponse.content;
      } else if (Array.isArray(claudeResponse.content)) {
        // 提取文本内容和工具调用
        const textParts = [];
        const toolCalls = [];
        
        for (const item of claudeResponse.content) {
          if (item.type === 'text') {
            textParts.push(item.text);
          } else if (item.type === 'tool_use') {
            toolCalls.push({
              id: item.id,
              type: 'function',
              function: {
                name: item.name,
                arguments: JSON.stringify(item.input)
              }
            });
          }
        }
        
        message.content = textParts.join('') || null;
        if (toolCalls.length > 0) {
          message.tool_calls = toolCalls;
        }
      }
    }

    return message;
  }

  /**
   * 转换停止原因
   */
  _mapStopReason(claudeReason) {
    return this.stopReasonMapping[claudeReason] || 'stop';
  }

  /**
   * 转换使用统计
   */
  _convertUsage(claudeUsage) {
    if (!claudeUsage) return undefined;
    
    return {
      prompt_tokens: claudeUsage.input_tokens || 0,
      completion_tokens: claudeUsage.output_tokens || 0,
      total_tokens: (claudeUsage.input_tokens || 0) + (claudeUsage.output_tokens || 0)
    };
  }

  /**
   * 转换流式事件
   */
  _convertStreamEvent(event, requestModel) {
    const timestamp = Math.floor(Date.now() / 1000);
    const baseChunk = {
      id: `chatcmpl-${this._generateId()}`,
      object: 'chat.completion.chunk',
      created: timestamp,
      model: requestModel || 'gpt-4',
      choices: [{
        index: 0,
        delta: {},
        finish_reason: null
      }]
    };

    // 根据事件类型处理
    if (event.type === 'content_block_start' && event.content_block) {
      if (event.content_block.type === 'text') {
        baseChunk.choices[0].delta.content = event.content_block.text || '';
      } else if (event.content_block.type === 'tool_use') {
        // 开始工具调用
        baseChunk.choices[0].delta.tool_calls = [{
          index: event.index || 0,
          id: event.content_block.id,
          type: 'function',
          function: {
            name: event.content_block.name,
            arguments: ''
          }
        }];
      }
    } else if (event.type === 'content_block_delta' && event.delta) {
      if (event.delta.type === 'text_delta') {
        baseChunk.choices[0].delta.content = event.delta.text || '';
      } else if (event.delta.type === 'input_json_delta') {
        // 工具调用参数的增量更新
        baseChunk.choices[0].delta.tool_calls = [{
          index: event.index || 0,
          function: {
            arguments: event.delta.partial_json || ''
          }
        }];
      }
    } else if (event.type === 'message_delta' && event.delta) {
      if (event.delta.stop_reason) {
        baseChunk.choices[0].finish_reason = this._mapStopReason(event.delta.stop_reason);
      }
      if (event.usage) {
        baseChunk.usage = this._convertUsage(event.usage);
      }
    } else if (event.type === 'message_stop') {
      baseChunk.choices[0].finish_reason = 'stop';
    }

    return baseChunk;
  }

  /**
   * 生成随机 ID
   */
  _generateId() {
    return Math.random().toString(36).substring(2, 15) + 
           Math.random().toString(36).substring(2, 15);
  }
}

module.exports = new OpenAIToClaudeConverter();