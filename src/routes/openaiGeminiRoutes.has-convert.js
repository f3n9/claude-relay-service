const express = require('express');
const router = express.Router();
const logger = require('../utils/logger');
const { authenticateApiKey } = require('../middleware/auth');
const geminiAccountService = require('../services/geminiAccountService');
const unifiedGeminiScheduler = require('../services/unifiedGeminiScheduler');
const sessionHelper = require('../utils/sessionHelper');

// 检查 API Key 权限
function checkPermissions(apiKeyData, requiredPermission = 'gemini') {
  const permissions = apiKeyData.permissions || 'all';
  return permissions === 'all' || permissions === requiredPermission;
}

// 转换 OpenAI 消息格式到 Gemini 格式
function convertMessagesToGemini(messages) {
  const contents = [];
  let systemInstruction = '';
  
  // 辅助函数：提取文本内容
  function extractTextContent(content) {
    if (typeof content === 'string') {
      return content;
    }
    
    if (Array.isArray(content)) {
      return content.map(item => {
        if (typeof item === 'string') {
          return item;
        }
        if (typeof item === 'object' && item.type === 'text' && item.text) {
          return item.text;
        }
        if (typeof item === 'object' && item.text) {
          return item.text;
        }
        return '';
      }).join('');
    }
    
    if (typeof content === 'object' && content.text) {
      return content.text;
    }
    
    return String(content);
  }
  
  for (const message of messages) {
    const textContent = extractTextContent(message.content);
    
    if (message.role === 'system') {
      systemInstruction += (systemInstruction ? '\n\n' : '') + textContent;
    } else if (message.role === 'user') {
      contents.push({
        role: 'user',
        parts: [{ text: textContent }]
      });
    } else if (message.role === 'assistant') {
      contents.push({
        role: 'model',
        parts: [{ text: textContent }]
      });
    }
  }
  
  return { contents, systemInstruction };
}

// 转换 Gemini 响应到 OpenAI 格式
function convertGeminiResponseToOpenAI(geminiResponse, model, stream = false) {
  if (stream) {
    // 处理流式响应 - 原样返回 SSE 数据
    return geminiResponse;
  } else {
    // 非流式响应转换
    if (geminiResponse.candidates && geminiResponse.candidates.length > 0) {
      const candidate = geminiResponse.candidates[0];
      const content = candidate.content?.parts?.[0]?.text || '';
      const finishReason = candidate.finishReason?.toLowerCase() || 'stop';

      // 计算 token 使用量
      const usage = geminiResponse.usageMetadata || {
        promptTokenCount: 0,
        candidatesTokenCount: 0,
        totalTokenCount: 0
      };

      return {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: [{
          index: 0,
          message: {
            role: 'assistant',
            content: content
          },
          finish_reason: finishReason
        }],
        usage: {
          prompt_tokens: usage.promptTokenCount,
          completion_tokens: usage.candidatesTokenCount,
          total_tokens: usage.totalTokenCount
        }
      };
    } else {
      throw new Error('No response from Gemini');
    }
  }
}

// OpenAI 兼容的聊天完成端点
router.post('/v1/chat/completions', authenticateApiKey, async (req, res) => {
  const startTime = Date.now();
  let abortController = null;
  
  try {
    const apiKeyData = req.apiKey;
    
    // 检查权限
    if (!checkPermissions(apiKeyData, 'gemini')) {
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access Gemini',
          type: 'permission_denied',
          code: 'permission_denied'
        }
      });
    }
    
    // 提取请求参数
    const {
      messages,
      model = 'gemini-2.0-flash-exp',
      temperature = 0.7,
      max_tokens = 4096,
      stream = false
    } = req.body;
    
    // 验证必需参数
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({
        error: {
          message: 'Messages array is required',
          type: 'invalid_request_error',
          code: 'invalid_request'
        }
      });
    }
    
    // 检查模型限制
    if (apiKeyData.enableModelRestriction && apiKeyData.restrictedModels.length > 0) {
      if (!apiKeyData.restrictedModels.includes(model)) {
        return res.status(403).json({
          error: {
            message: `Model ${model} is not allowed for this API key`,
            type: 'invalid_request_error',
            code: 'model_not_allowed'
          }
        });
      }
    }
    
    // 转换消息格式
    const { contents, systemInstruction } = convertMessagesToGemini(messages);
    
    // 构建 Gemini 请求体
    const geminiRequestBody = {
      contents,
      generationConfig: {
        temperature,
        maxOutputTokens: max_tokens,
        candidateCount: 1
      }
    };
    
    if (systemInstruction) {
      geminiRequestBody.systemInstruction = { parts: [{ text: systemInstruction }] };
    }
    
    // 生成会话哈希
    const sessionHash = sessionHelper.generateSessionHash(req.body);
    
    // 使用统一调度选择账号
    const { accountId } = await unifiedGeminiScheduler.selectAccountForApiKey(req.apiKey, sessionHash, model);
    const account = await geminiAccountService.getAccount(accountId);
    const { accessToken, refreshToken } = account;
    
    logger.info(`Using Gemini account: ${accountId} for API key: ${apiKeyData.id}`);
    
    // 创建中止控制器
    abortController = new AbortController();
    
    // 处理客户端断开连接
    req.on('close', () => {
      if (abortController && !abortController.signal.aborted) {
        logger.info('Client disconnected, aborting Gemini request');
        abortController.abort();
      }
    });
    
    const client = await geminiAccountService.getOauthClient(accessToken, refreshToken);
    
    if (stream) {
      // 流式响应
      logger.info('StreamGenerateContent request', {
        model: model,
        projectId: account.projectId,
        apiKeyId: req.apiKey?.id || 'unknown'
      });
      
      const streamResponse = await geminiAccountService.generateContentStream(
        client,
        { model, request: geminiRequestBody },
        null, // user_prompt_id
        account.projectId,
        req.apiKey?.id, // 使用 API Key ID 作为 session ID
        abortController.signal // 传递中止信号
      );
      
      // 设置 SSE 响应头
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      
      // 处理流式响应，转换为 OpenAI 格式
      let buffer = '';
      
      streamResponse.on('data', (chunk) => {
        try {
          buffer += chunk.toString();
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 保留最后一个不完整的行
          
          for (const line of lines) {
            if (!line.trim()) continue;
            
            // 处理 SSE 格式
            let jsonData = line;
            if (line.startsWith('data: ')) {
              jsonData = line.substring(6).trim();
            }
            
            if (!jsonData || jsonData === '[DONE]') continue;
            
            try {
              const data = JSON.parse(jsonData);
              
              // 转换为 OpenAI 流式格式
              if (data.candidates && data.candidates.length > 0) {
                const candidate = data.candidates[0];
                const content = candidate.content?.parts?.[0]?.text || '';
                const finishReason = candidate.finishReason?.toLowerCase();
                
                const openaiChunk = {
                  id: `chatcmpl-${Date.now()}`,
                  object: 'chat.completion.chunk',
                  created: Math.floor(Date.now() / 1000),
                  model: model,
                  choices: [{
                    index: 0,
                    delta: {
                      content: content
                    },
                    finish_reason: finishReason === 'stop' ? 'stop' : null
                  }]
                };
                
                res.write(`data: ${JSON.stringify(openaiChunk)}\n\n`);
                
                // 如果结束了，发送最终的 [DONE]
                if (finishReason === 'stop') {
                  res.write('data: [DONE]\n\n');
                }
              }
            } catch (e) {
              logger.debug('Error parsing JSON line:', e.message);
            }
          }
        } catch (error) {
          logger.error('Stream processing error:', error);
          if (!res.headersSent) {
            res.status(500).json({
              error: {
                message: error.message || 'Stream error',
                type: 'api_error'
              }
            });
          }
        }
      });
      
      streamResponse.on('end', () => {
        logger.info('Stream completed successfully');
        if (!res.headersSent) {
          res.write('data: [DONE]\n\n');
        }
        res.end();
      });
      
      streamResponse.on('error', (error) => {
        logger.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({
            error: {
              message: error.message || 'Stream error',
              type: 'api_error'
            }
          });
        } else {
          res.end();
        }
      });
      
    } else {
      // 非流式响应
      logger.info('GenerateContent request', {
        model: model,
        projectId: account.projectId,
        apiKeyId: req.apiKey?.id || 'unknown'
      });
      
      const response = await geminiAccountService.generateContent(
        client,
        { model, request: geminiRequestBody },
        null, // user_prompt_id
        account.projectId,
        req.apiKey?.id // 使用 API Key ID 作为 session ID
      );
      
      // 转换为 OpenAI 格式并返回
      const openaiResponse = convertGeminiResponseToOpenAI(response, model, false);
      res.json(openaiResponse);
    }
    
    const duration = Date.now() - startTime;
    logger.info(`OpenAI-Gemini request completed in ${duration}ms`);
    
  } catch (error) {
    logger.error('OpenAI-Gemini request error:', error);
    
    // 返回 OpenAI 格式的错误响应
    const status = error.status || 500;
    const errorResponse = {
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error',
        code: 'internal_error'
      }
    };
    
    if (!res.headersSent) {
      res.status(status).json(errorResponse);
    }
  } finally {
    // 清理资源
    if (abortController) {
      abortController = null;
    }
  }
});

// 获取模型列表端点（OpenAI 兼容）
router.get('/v1/models', authenticateApiKey, async (req, res) => {
  try {
    const apiKeyData = req.apiKey;
    
    // 检查权限
    if (!checkPermissions(apiKeyData, 'gemini')) {
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access Gemini',
          type: 'permission_denied',
          code: 'permission_denied'
        }
      });
    }
    
    // 返回支持的 Gemini 模型列表（OpenAI 格式）
    const models = [
      {
        id: 'gemini-2.0-flash-exp',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google'
      },
      {
        id: 'gemini-2.0-flash-thinking-exp',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google'
      },
      {
        id: 'gemini-1.5-pro',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google'
      },
      {
        id: 'gemini-1.5-flash',
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'google'
      }
    ];
    
    res.json({
      object: 'list',
      data: models
    });
  } catch (error) {
    logger.error('Error getting models:', error);
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error'
      }
    });
  }
});

module.exports = router;