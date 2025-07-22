/**
 * OpenAI 兼容的 Claude API 路由
 * 提供 OpenAI 格式的 API 接口，内部转发到 Claude
 */

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { authenticateApiKey } = require('../middleware/auth');
const claudeRelayService = require('../services/claudeRelayService');
const openaiToClaude = require('../services/openaiToClaude');
const apiKeyService = require('../services/apiKeyService');

// 加载模型定价数据
let modelPricingData = {};
try {
  const pricingPath = path.join(__dirname, '../../data/model_pricing.json');
  const pricingContent = fs.readFileSync(pricingPath, 'utf8');
  modelPricingData = JSON.parse(pricingContent);
  logger.info('✅ Model pricing data loaded successfully');
} catch (error) {
  logger.error('❌ Failed to load model pricing data:', error);
}

// 🔧 辅助函数：检查 API Key 权限
function checkPermissions(apiKeyData, requiredPermission = 'claude') {
  const permissions = apiKeyData.permissions || 'all';
  return permissions === 'all' || permissions === requiredPermission;
}

// 🚀 OpenAI 兼容的聊天完成端点
router.post('/v1/chat/completions', authenticateApiKey, async (req, res) => {
  const startTime = Date.now();
  let abortController = null;
  
  try {
    const apiKeyData = req.apiKeyData;
    
    // 检查权限
    if (!checkPermissions(apiKeyData, 'claude')) {
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access Claude',
          type: 'permission_denied',
          code: 'permission_denied'
        }
      });
    }
    
    // 记录原始请求
    logger.debug('📥 Received OpenAI format request:', {
      model: req.body.model,
      messageCount: req.body.messages?.length,
      stream: req.body.stream,
      maxTokens: req.body.max_tokens
    });
    
    // 转换 OpenAI 请求为 Claude 格式
    const claudeRequest = openaiToClaude.convertRequest(req.body);
    
    // 检查模型限制
    if (apiKeyData.enableModelRestriction && apiKeyData.restrictedModels?.length > 0) {
      if (!apiKeyData.restrictedModels.includes(claudeRequest.model)) {
        return res.status(403).json({
          error: {
            message: `Model ${req.body.model} is not allowed for this API key`,
            type: 'invalid_request_error',
            code: 'model_not_allowed'
          }
        });
      }
    }
    
    // 处理流式请求
    if (claudeRequest.stream) {
      logger.info(`🌊 Processing OpenAI stream request for model: ${req.body.model}`);
      
      // 设置 SSE 响应头
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      
      
      // 创建中止控制器
      abortController = new AbortController();
      
      // 处理客户端断开
      req.on('close', () => {
        if (abortController && !abortController.signal.aborted) {
          logger.info('🔌 Client disconnected, aborting Claude request');
          abortController.abort();
        }
      });
      
      // 使用转换后的响应流
      await claudeRelayService.relayStreamRequestWithUsageCapture(
        claudeRequest, 
        apiKeyData, 
        res, 
        req.headers,
        (usage) => {
          usageData = usage;
          // 记录使用统计
          if (usage && usage.input_tokens !== undefined && usage.output_tokens !== undefined) {
            const inputTokens = usage.input_tokens || 0;
            const outputTokens = usage.output_tokens || 0;
            const cacheCreateTokens = usage.cache_creation_input_tokens || 0;
            const cacheReadTokens = usage.cache_read_input_tokens || 0;
            const model = usage.model || claudeRequest.model;
            
            apiKeyService.recordUsage(
              apiKeyData.id, 
              inputTokens, 
              outputTokens, 
              cacheCreateTokens, 
              cacheReadTokens, 
              model
            ).catch(error => {
              logger.error('❌ Failed to record usage:', error);
            });
          }
        },
        // 流转换器
        (chunk) => {
          return openaiToClaude.convertStreamChunk(chunk, req.body.model);
        }
      );
      
    } else {
      // 非流式请求
      logger.info(`📄 Processing OpenAI non-stream request for model: ${req.body.model}`);
      
      // 发送请求到 Claude
      const claudeResponse = await claudeRelayService.relayRequest(
        claudeRequest, 
        apiKeyData, 
        req, 
        res, 
        req.headers
      );
      
      // 解析 Claude 响应
      let claudeData;
      try {
        claudeData = JSON.parse(claudeResponse.body);
      } catch (error) {
        logger.error('❌ Failed to parse Claude response:', error);
        return res.status(502).json({
          error: {
            message: 'Invalid response from Claude API',
            type: 'api_error',
            code: 'invalid_response'
          }
        });
      }
      
      // 处理错误响应
      if (claudeResponse.statusCode >= 400) {
        return res.status(claudeResponse.statusCode).json({
          error: {
            message: claudeData.error?.message || 'Claude API error',
            type: claudeData.error?.type || 'api_error',
            code: claudeData.error?.code || 'unknown_error'
          }
        });
      }
      
      // 转换为 OpenAI 格式
      const openaiResponse = openaiToClaude.convertResponse(claudeData, req.body.model);
      
      // 记录使用统计
      if (claudeData.usage) {
        const usage = claudeData.usage;
        apiKeyService.recordUsage(
          apiKeyData.id,
          usage.input_tokens || 0,
          usage.output_tokens || 0,
          usage.cache_creation_input_tokens || 0,
          usage.cache_read_input_tokens || 0,
          claudeRequest.model
        ).catch(error => {
          logger.error('❌ Failed to record usage:', error);
        });
      }
      
      // 返回 OpenAI 格式响应
      res.json(openaiResponse);
    }
    
    const duration = Date.now() - startTime;
    logger.info(`✅ OpenAI-Claude request completed in ${duration}ms`);
    
  } catch (error) {
    logger.error('❌ OpenAI-Claude request error:', error);
    
    const status = error.status || 500;
    res.status(status).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'server_error',
        code: 'internal_error'
      }
    });
  } finally {
    // 清理资源
    if (abortController) {
      abortController = null;
    }
  }
});

// 📋 OpenAI 兼容的模型列表端点
router.get('/v1/models', authenticateApiKey, async (req, res) => {
  try {
    const apiKeyData = req.apiKeyData;
    
    // 检查权限
    if (!checkPermissions(apiKeyData, 'claude')) {
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access Claude',
          type: 'permission_denied',
          code: 'permission_denied'
        }
      });
    }
    
    // Claude 模型列表 - 只返回 opus-4 和 sonnet-4
    let models = [
      {
        id: 'claude-opus-4-20250514',
        object: 'model',
        created: 1736726400, // 2025-01-13
        owned_by: 'anthropic'
      },
      {
        id: 'claude-sonnet-4-20250514',
        object: 'model',
        created: 1736726400, // 2025-01-13
        owned_by: 'anthropic'
      }
    ];
    
    // 如果启用了模型限制，过滤模型列表
    if (apiKeyData.enableModelRestriction && apiKeyData.restrictedModels?.length > 0) {
      models = models.filter(model => apiKeyData.restrictedModels.includes(model.id));
    }
    
    res.json({
      object: 'list',
      data: models
    });
    
  } catch (error) {
    logger.error('❌ Failed to get OpenAI-Claude models:', error);
    res.status(500).json({
      error: {
        message: 'Failed to retrieve models',
        type: 'server_error',
        code: 'internal_error'
      }
    });
  }
});

// 📄 OpenAI 兼容的模型详情端点
router.get('/v1/models/:model', authenticateApiKey, async (req, res) => {
  try {
    const apiKeyData = req.apiKeyData;
    const modelId = req.params.model;
    
    // 检查权限
    if (!checkPermissions(apiKeyData, 'claude')) {
      return res.status(403).json({
        error: {
          message: 'This API key does not have permission to access Claude',
          type: 'permission_denied',
          code: 'permission_denied'
        }
      });
    }
    
    // 检查模型限制
    if (apiKeyData.enableModelRestriction && apiKeyData.restrictedModels?.length > 0) {
      if (!apiKeyData.restrictedModels.includes(modelId)) {
        return res.status(404).json({
          error: {
            message: `Model '${modelId}' not found`,
            type: 'invalid_request_error',
            code: 'model_not_found'
          }
        });
      }
    }
    
    // 从 model_pricing.json 获取模型信息
    const modelData = modelPricingData[modelId];
    
    // 构建标准 OpenAI 格式的模型响应
    let modelInfo;
    
    if (modelData) {
      // 如果在 pricing 文件中找到了模型
      modelInfo = {
        id: modelId,
        object: 'model',
        created: 1736726400, // 2025-01-13
        owned_by: 'anthropic',
        permission: [],
        root: modelId,
        parent: null
      };
    } else {
      // 如果没找到，返回默认信息（但仍保持正确格式）
      modelInfo = {
        id: modelId,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'anthropic',
        permission: [],
        root: modelId,
        parent: null
      };
    }
    
    res.json(modelInfo);
    
  } catch (error) {
    logger.error('❌ Failed to get model details:', error);
    res.status(500).json({
      error: {
        message: 'Failed to retrieve model details',
        type: 'server_error',
        code: 'internal_error'
      }
    });
  }
});

// 🔧 OpenAI 兼容的 completions 端点（传统格式，转换为 chat 格式）
router.post('/v1/completions', authenticateApiKey, async (req, res) => {
  try {
    // 将传统 completions 格式转换为 chat 格式
    const chatRequest = {
      model: req.body.model,
      messages: [
        {
          role: 'user',
          content: req.body.prompt
        }
      ],
      max_tokens: req.body.max_tokens,
      temperature: req.body.temperature,
      top_p: req.body.top_p,
      stream: req.body.stream,
      stop: req.body.stop
    };
    
    // 使用 chat completions 处理
    req.body = chatRequest;
    
    // 调用 chat completions 端点
    return router.handle(req, res);
    
  } catch (error) {
    logger.error('❌ OpenAI completions error:', error);
    res.status(500).json({
      error: {
        message: 'Failed to process completion request',
        type: 'server_error',
        code: 'internal_error'
      }
    });
  }
});

module.exports = router;