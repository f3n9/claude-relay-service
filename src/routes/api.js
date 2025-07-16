const express = require('express');
const claudeRelayService = require('../services/claudeRelayService');
const apiKeyService = require('../services/apiKeyService');
const { authenticateApiKey } = require('../middleware/auth');
const logger = require('../utils/logger');

const router = express.Router();

// 🚀 Claude API messages 端点
router.post('/v1/messages', authenticateApiKey, async (req, res) => {
  try {
    const startTime = Date.now();
    
    // 严格的输入验证
    if (!req.body || typeof req.body !== 'object') {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Request body must be a valid JSON object'
      });
    }

    if (!req.body.messages || !Array.isArray(req.body.messages)) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Missing or invalid field: messages (must be an array)'
      });
    }

    if (req.body.messages.length === 0) {
      return res.status(400).json({
        error: 'Invalid request',
        message: 'Messages array cannot be empty'
      });
    }

    // 检查是否为流式请求
    const isStream = req.body.stream === true;
    
    logger.api(`🚀 Processing ${isStream ? 'stream' : 'non-stream'} request for key: ${req.apiKey.name}`);

    if (isStream) {
      // 流式响应 - 只使用官方真实usage数据
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('Access-Control-Allow-Origin', '*');
      
      // 为流式响应添加客户端断开检测，确保并发计数正确减少
      if (req.concurrencyInfo) {
        // 添加响应关闭事件监听器
        res.on('close', () => {
          logger.api(`🔌 Stream response closed for key: ${req.apiKey.id} (${req.apiKey.name}), triggering concurrency decrement`);
          req.concurrencyInfo.decrementConcurrency();
        });
        
        // 添加错误事件监听器
        res.on('error', (error) => {
          logger.api(`⚠️ Stream response error for key: ${req.apiKey.id} (${req.apiKey.name}): ${error.message}`);
          req.concurrencyInfo.decrementConcurrency();
        });
      }
      
      let usageDataCaptured = false;
      
      // 使用自定义流处理器来捕获usage数据
      await claudeRelayService.relayStreamRequestWithUsageCapture(req.body, req.apiKey, res, (usageData) => {
        // 回调函数：当检测到完整usage数据时记录真实token使用量
        logger.info('🎯 Usage callback triggered with complete data:', JSON.stringify(usageData, null, 2));
        
        if (usageData && usageData.input_tokens !== undefined && usageData.output_tokens !== undefined) {
          const inputTokens = usageData.input_tokens || 0;
          const outputTokens = usageData.output_tokens || 0;
          const cacheCreateTokens = usageData.cache_creation_input_tokens || 0;
          const cacheReadTokens = usageData.cache_read_input_tokens || 0;
          const model = usageData.model || 'unknown';
          
          // 记录真实的token使用量（包含模型信息和所有4种token）
          apiKeyService.recordUsage(req.apiKey.id, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model).catch(error => {
            logger.error('❌ Failed to record stream usage:', error);
          });
          
          usageDataCaptured = true;
          logger.api(`📊 Stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`);
        } else {
          logger.warn('⚠️ Usage callback triggered but data is incomplete:', JSON.stringify(usageData));
        }
      });
      
      // 流式请求完成后 - 如果没有捕获到usage数据，记录警告但不进行估算
      setTimeout(() => {
        if (!usageDataCaptured) {
          logger.warn('⚠️ No usage data captured from SSE stream - no statistics recorded (official data only)');
        }
      }, 1000); // 1秒后检查
    } else {
      // 非流式响应 - 只使用官方真实usage数据
      logger.info('📄 Starting non-streaming request', {
        apiKeyId: req.apiKey.id,
        apiKeyName: req.apiKey.name
      });
      
      const response = await claudeRelayService.relayRequest(req.body, req.apiKey);
      
      logger.info('📡 Claude API response received', {
        statusCode: response.statusCode,
        headers: JSON.stringify(response.headers),
        bodyLength: response.body ? response.body.length : 0
      });
      
      res.status(response.statusCode);
      
      // 设置响应头
      Object.keys(response.headers).forEach(key => {
        if (key.toLowerCase() !== 'content-encoding') {
          res.setHeader(key, response.headers[key]);
        }
      });
      
      let usageRecorded = false;
      
      // 尝试解析JSON响应并提取usage信息
      try {
        const jsonData = JSON.parse(response.body);
        
        logger.info('📊 Parsed Claude API response:', JSON.stringify(jsonData, null, 2));
        
        // 从Claude API响应中提取usage信息（完整的token分类体系）
        if (jsonData.usage && jsonData.usage.input_tokens !== undefined && jsonData.usage.output_tokens !== undefined) {
          const inputTokens = jsonData.usage.input_tokens || 0;
          const outputTokens = jsonData.usage.output_tokens || 0;
          const cacheCreateTokens = jsonData.usage.cache_creation_input_tokens || 0;
          const cacheReadTokens = jsonData.usage.cache_read_input_tokens || 0;
          const model = jsonData.model || req.body.model || 'unknown';
          
          // 记录真实的token使用量（包含模型信息和所有4种token）
          await apiKeyService.recordUsage(req.apiKey.id, inputTokens, outputTokens, cacheCreateTokens, cacheReadTokens, model);
          
          usageRecorded = true;
          logger.api(`📊 Non-stream usage recorded (real) - Model: ${model}, Input: ${inputTokens}, Output: ${outputTokens}, Cache Create: ${cacheCreateTokens}, Cache Read: ${cacheReadTokens}, Total: ${inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens} tokens`);
        } else {
          logger.warn('⚠️ No usage data found in Claude API JSON response');
        }
        
        res.json(jsonData);
      } catch (parseError) {
        logger.warn('⚠️ Failed to parse Claude API response as JSON:', parseError.message);
        logger.info('📄 Raw response body:', response.body);
        res.send(response.body);
      }
      
      // 如果没有记录usage，只记录警告，不进行估算
      if (!usageRecorded) {
        logger.warn('⚠️ No usage data recorded for non-stream request - no statistics recorded (official data only)');
      }
    }
    
    const duration = Date.now() - startTime;
    logger.api(`✅ Request completed in ${duration}ms for key: ${req.apiKey.name}`);
    
  } catch (error) {
    logger.error('❌ Claude relay error:', error);
    
    if (!res.headersSent) {
      res.status(500).json({
        error: 'Relay service error',
        message: error.message
      });
    }
  }
});

// 🏥 健康检查端点
router.get('/health', async (req, res) => {
  try {
    const healthStatus = await claudeRelayService.healthCheck();
    
    res.status(healthStatus.healthy ? 200 : 503).json({
      status: healthStatus.healthy ? 'healthy' : 'unhealthy',
      service: 'claude-relay-service',
      version: '1.0.0',
      ...healthStatus
    });
  } catch (error) {
    logger.error('❌ Health check error:', error);
    res.status(503).json({
      status: 'unhealthy',
      service: 'claude-relay-service',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// 📊 API Key状态检查端点
router.get('/v1/key-info', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id);
    
    res.json({
      keyInfo: {
        id: req.apiKey.id,
        name: req.apiKey.name,
        tokenLimit: req.apiKey.tokenLimit,
        requestLimit: req.apiKey.requestLimit,
        usage
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Key info error:', error);
    res.status(500).json({
      error: 'Failed to get key info',
      message: error.message
    });
  }
});

// 📈 使用统计端点
router.get('/v1/usage', authenticateApiKey, async (req, res) => {
  try {
    const usage = await apiKeyService.getUsageStats(req.apiKey.id);
    
    res.json({
      usage,
      limits: {
        tokens: req.apiKey.tokenLimit,
        requests: req.apiKey.requestLimit
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    logger.error('❌ Usage stats error:', error);
    res.status(500).json({
      error: 'Failed to get usage stats',
      message: error.message
    });
  }
});

module.exports = router;