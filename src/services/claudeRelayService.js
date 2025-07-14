const https = require('https');
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');
const claudeAccountService = require('./claudeAccountService');
const logger = require('../utils/logger');
const config = require('../../config/config');

class ClaudeRelayService {
  constructor() {
    this.claudeApiUrl = config.claude.apiUrl;
    this.apiVersion = config.claude.apiVersion;
    this.betaHeader = config.claude.betaHeader;
    this.systemPrompt = config.claude.systemPrompt;
  }

  // 🚀 转发请求到Claude API
  async relayRequest(requestBody, apiKeyData) {
    try {
      // 选择可用的Claude账户
      const accountId = apiKeyData.claudeAccountId || await claudeAccountService.selectAvailableAccount();
      
      logger.info(`📤 Processing API request for key: ${apiKeyData.name || apiKeyData.id}, account: ${accountId}`);
      
      // 获取有效的访问token
      const accessToken = await claudeAccountService.getValidAccessToken(accountId);
      
      // 处理请求体
      const processedBody = this._processRequestBody(requestBody);
      
      // 获取代理配置
      const proxyAgent = await this._getProxyAgent(accountId);
      
      // 发送请求到Claude API
      const response = await this._makeClaudeRequest(processedBody, accessToken, proxyAgent);
      
      // 记录成功的API调用
      const inputTokens = requestBody.messages ? 
        requestBody.messages.reduce((sum, msg) => sum + (msg.content?.length || 0), 0) / 4 : 0; // 粗略估算
      const outputTokens = response.content ? 
        response.content.reduce((sum, content) => sum + (content.text?.length || 0), 0) / 4 : 0;
      
      logger.info(`✅ API request completed - Key: ${apiKeyData.name}, Account: ${accountId}, Model: ${requestBody.model}, Input: ~${Math.round(inputTokens)} tokens, Output: ~${Math.round(outputTokens)} tokens`);
      
      return response;
    } catch (error) {
      logger.error(`❌ Claude relay request failed for key: ${apiKeyData.name || apiKeyData.id}:`, error.message);
      throw error;
    }
  }

  // 🔄 处理请求体
  _processRequestBody(body) {
    if (!body) return body;

    // 深拷贝请求体
    const processedBody = JSON.parse(JSON.stringify(body));

    // 移除cache_control中的ttl字段
    this._stripTtlFromCacheControl(processedBody);

    // 只有在配置了系统提示时才添加
    if (this.systemPrompt && this.systemPrompt.trim()) {
      const systemPrompt = {
        type: 'text',
        text: this.systemPrompt
      };

      if (processedBody.system) {
        if (Array.isArray(processedBody.system)) {
          // 如果system数组存在但为空，或者没有有效内容，则添加系统提示
          const hasValidContent = processedBody.system.some(item => 
            item && item.text && item.text.trim()
          );
          if (!hasValidContent) {
            processedBody.system = [systemPrompt];
          } else {
            processedBody.system.unshift(systemPrompt);
          }
        } else {
          throw new Error('system field must be an array');
        }
      } else {
        processedBody.system = [systemPrompt];
      }
    } else {
      // 如果没有配置系统提示，且system字段为空，则删除它
      if (processedBody.system && Array.isArray(processedBody.system)) {
        const hasValidContent = processedBody.system.some(item => 
          item && item.text && item.text.trim()
        );
        if (!hasValidContent) {
          delete processedBody.system;
        }
      }
    }

    return processedBody;
  }

  // 🧹 移除TTL字段
  _stripTtlFromCacheControl(body) {
    if (!body || typeof body !== 'object') return;

    const processContentArray = (contentArray) => {
      if (!Array.isArray(contentArray)) return;
      
      contentArray.forEach(item => {
        if (item && typeof item === 'object' && item.cache_control) {
          if (item.cache_control.ttl) {
            delete item.cache_control.ttl;
            logger.debug('🧹 Removed ttl from cache_control');
          }
        }
      });
    };

    if (Array.isArray(body.system)) {
      processContentArray(body.system);
    }

    if (Array.isArray(body.messages)) {
      body.messages.forEach(message => {
        if (message && Array.isArray(message.content)) {
          processContentArray(message.content);
        }
      });
    }
  }

  // 🌐 获取代理Agent
  async _getProxyAgent(accountId) {
    try {
      const accountData = await claudeAccountService.getAllAccounts();
      const account = accountData.find(acc => acc.id === accountId);
      
      if (!account || !account.proxy) {
        return null;
      }

      const proxy = account.proxy;
      
      if (proxy.type === 'socks5') {
        const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : '';
        const socksUrl = `socks5://${auth}${proxy.host}:${proxy.port}`;
        return new SocksProxyAgent(socksUrl);
      } else if (proxy.type === 'http' || proxy.type === 'https') {
        const auth = proxy.username && proxy.password ? `${proxy.username}:${proxy.password}@` : '';
        const httpUrl = `${proxy.type}://${auth}${proxy.host}:${proxy.port}`;
        return new HttpsProxyAgent(httpUrl);
      }
    } catch (error) {
      logger.warn('⚠️ Failed to create proxy agent:', error);
    }

    return null;
  }

  // 🔗 发送请求到Claude API
  async _makeClaudeRequest(body, accessToken, proxyAgent) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.claudeApiUrl);
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-version': this.apiVersion,
          'User-Agent': 'claude-relay-service/1.0.0'
        },
        agent: proxyAgent,
        timeout: config.proxy.timeout
      };

      if (this.betaHeader) {
        options.headers['anthropic-beta'] = this.betaHeader;
      }

      const req = https.request(options, (res) => {
        let responseData = '';
        
        res.on('data', (chunk) => {
          responseData += chunk;
        });
        
        res.on('end', () => {
          try {
            const response = {
              statusCode: res.statusCode,
              headers: res.headers,
              body: responseData
            };
            
            logger.debug(`🔗 Claude API response: ${res.statusCode}`);
            
            resolve(response);
          } catch (error) {
            logger.error('❌ Failed to parse Claude API response:', error);
            reject(error);
          }
        });
      });

      req.on('error', (error) => {
        logger.error('❌ Claude API request error:', error);
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        logger.error('❌ Claude API request timeout');
        reject(new Error('Request timeout'));
      });

      // 写入请求体
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  // 🌊 处理流式响应（带usage数据捕获）
  async relayStreamRequestWithUsageCapture(requestBody, apiKeyData, responseStream, usageCallback) {
    try {
      // 选择可用的Claude账户
      const accountId = apiKeyData.claudeAccountId || await claudeAccountService.selectAvailableAccount();
      
      logger.info(`📡 Processing streaming API request with usage capture for key: ${apiKeyData.name || apiKeyData.id}, account: ${accountId}`);
      
      // 获取有效的访问token
      const accessToken = await claudeAccountService.getValidAccessToken(accountId);
      
      // 处理请求体
      const processedBody = this._processRequestBody(requestBody);
      
      // 获取代理配置
      const proxyAgent = await this._getProxyAgent(accountId);
      
      // 发送流式请求并捕获usage数据
      return await this._makeClaudeStreamRequestWithUsageCapture(processedBody, accessToken, proxyAgent, responseStream, usageCallback);
    } catch (error) {
      logger.error('❌ Claude stream relay with usage capture failed:', error);
      throw error;
    }
  }

  // 🌊 发送流式请求到Claude API（带usage数据捕获）
  async _makeClaudeStreamRequestWithUsageCapture(body, accessToken, proxyAgent, responseStream, usageCallback) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.claudeApiUrl);
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-version': this.apiVersion,
          'User-Agent': 'claude-relay-service/1.0.0'
        },
        agent: proxyAgent,
        timeout: config.proxy.timeout
      };

      if (this.betaHeader) {
        options.headers['anthropic-beta'] = this.betaHeader;
      }

      const req = https.request(options, (res) => {
        // 设置响应头
        responseStream.statusCode = res.statusCode;
        Object.keys(res.headers).forEach(key => {
          responseStream.setHeader(key, res.headers[key]);
        });

        let buffer = '';
        let finalUsageReported = false; // 防止重复统计的标志
        let collectedUsageData = {}; // 收集来自不同事件的usage数据
        
        // 监听数据块，解析SSE并寻找usage信息
        res.on('data', (chunk) => {
          const chunkStr = chunk.toString();
          
          // 记录原始SSE数据块
          logger.info('📡 Raw SSE chunk received:', {
            length: chunkStr.length,
            content: chunkStr
          });
          
          buffer += chunkStr;
          
          // 处理完整的SSE行
          const lines = buffer.split('\n');
          buffer = lines.pop() || ''; // 保留最后的不完整行
          
          // 转发已处理的完整行到客户端
          if (lines.length > 0) {
            const linesToForward = lines.join('\n') + (lines.length > 0 ? '\n' : '');
            responseStream.write(linesToForward);
          }
          
          for (const line of lines) {
            // 记录每个SSE行
            if (line.trim()) {
              logger.info('📄 SSE Line:', line);
            }
            
            // 解析SSE数据寻找usage信息
            if (line.startsWith('data: ') && line.length > 6) {
              try {
                const jsonStr = line.slice(6);
                const data = JSON.parse(jsonStr);
                
                // 收集来自不同事件的usage数据
                if (data.type === 'message_start' && data.message && data.message.usage) {
                  // message_start包含input tokens、cache tokens和模型信息
                  collectedUsageData.input_tokens = data.message.usage.input_tokens || 0;
                  collectedUsageData.cache_creation_input_tokens = data.message.usage.cache_creation_input_tokens || 0;
                  collectedUsageData.cache_read_input_tokens = data.message.usage.cache_read_input_tokens || 0;
                  collectedUsageData.model = data.message.model;
                  
                  logger.info('📊 Collected input/cache data from message_start:', JSON.stringify(collectedUsageData));
                }
                
                // message_delta包含最终的output tokens
                if (data.type === 'message_delta' && data.usage && data.usage.output_tokens !== undefined) {
                  collectedUsageData.output_tokens = data.usage.output_tokens || 0;
                  
                  logger.info('📊 Collected output data from message_delta:', JSON.stringify(collectedUsageData));
                  
                  // 如果已经收集到了input数据，现在有了output数据，可以统计了
                  if (collectedUsageData.input_tokens !== undefined && !finalUsageReported) {
                    logger.info('🎯 Complete usage data collected, triggering callback');
                    usageCallback(collectedUsageData);
                    finalUsageReported = true;
                  }
                }
                
              } catch (parseError) {
                // 忽略JSON解析错误，继续处理
                logger.debug('🔍 SSE line not JSON or no usage data:', line.slice(0, 100));
              }
            }
          }
        });
        
        res.on('end', () => {
          // 处理缓冲区中剩余的数据
          if (buffer.trim()) {
            responseStream.write(buffer);
          }
          responseStream.end();
          
          // 检查是否捕获到usage数据
          if (!finalUsageReported) {
            logger.warn('⚠️ Stream completed but no usage data was captured! This indicates a problem with SSE parsing or Claude API response format.');
          }
          
          logger.debug('🌊 Claude stream response with usage capture completed');
          resolve();
        });
      });

      req.on('error', (error) => {
        logger.error('❌ Claude stream request error:', error);
        if (!responseStream.headersSent) {
          responseStream.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!responseStream.destroyed) {
          responseStream.end(JSON.stringify({ error: 'Upstream request failed' }));
        }
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        logger.error('❌ Claude stream request timeout');
        if (!responseStream.headersSent) {
          responseStream.writeHead(504, { 'Content-Type': 'application/json' });
        }
        if (!responseStream.destroyed) {
          responseStream.end(JSON.stringify({ error: 'Request timeout' }));
        }
        reject(new Error('Request timeout'));
      });

      // 处理客户端断开连接
      responseStream.on('close', () => {
        logger.debug('🔌 Client disconnected, cleaning up stream');
        if (!req.destroyed) {
          req.destroy();
        }
      });

      // 写入请求体
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  // 🌊 发送流式请求到Claude API
  async _makeClaudeStreamRequest(body, accessToken, proxyAgent, responseStream) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.claudeApiUrl);
      
      const options = {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${accessToken}`,
          'anthropic-version': this.apiVersion,
          'User-Agent': 'claude-relay-service/1.0.0'
        },
        agent: proxyAgent,
        timeout: config.proxy.timeout
      };

      if (this.betaHeader) {
        options.headers['anthropic-beta'] = this.betaHeader;
      }

      const req = https.request(options, (res) => {
        // 设置响应头
        responseStream.statusCode = res.statusCode;
        Object.keys(res.headers).forEach(key => {
          responseStream.setHeader(key, res.headers[key]);
        });

        // 管道响应数据
        res.pipe(responseStream);
        
        res.on('end', () => {
          logger.debug('🌊 Claude stream response completed');
          resolve();
        });
      });

      req.on('error', (error) => {
        logger.error('❌ Claude stream request error:', error);
        if (!responseStream.headersSent) {
          responseStream.writeHead(500, { 'Content-Type': 'application/json' });
        }
        if (!responseStream.destroyed) {
          responseStream.end(JSON.stringify({ error: 'Upstream request failed' }));
        }
        reject(error);
      });

      req.on('timeout', () => {
        req.destroy();
        logger.error('❌ Claude stream request timeout');
        if (!responseStream.headersSent) {
          responseStream.writeHead(504, { 'Content-Type': 'application/json' });
        }
        if (!responseStream.destroyed) {
          responseStream.end(JSON.stringify({ error: 'Request timeout' }));
        }
        reject(new Error('Request timeout'));
      });

      // 处理客户端断开连接
      responseStream.on('close', () => {
        logger.debug('🔌 Client disconnected, cleaning up stream');
        if (!req.destroyed) {
          req.destroy();
        }
      });

      // 写入请求体
      req.write(JSON.stringify(body));
      req.end();
    });
  }

  // 🔄 重试逻辑
  async _retryRequest(requestFunc, maxRetries = 3) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        return await requestFunc();
      } catch (error) {
        lastError = error;
        
        if (i < maxRetries - 1) {
          const delay = Math.pow(2, i) * 1000; // 指数退避
          logger.warn(`⏳ Retry ${i + 1}/${maxRetries} in ${delay}ms: ${error.message}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    throw lastError;
  }

  // 🎯 健康检查
  async healthCheck() {
    try {
      const accounts = await claudeAccountService.getAllAccounts();
      const activeAccounts = accounts.filter(acc => acc.isActive && acc.status === 'active');
      
      return {
        healthy: activeAccounts.length > 0,
        activeAccounts: activeAccounts.length,
        totalAccounts: accounts.length,
        timestamp: new Date().toISOString()
      };
    } catch (error) {
      logger.error('❌ Health check failed:', error);
      return {
        healthy: false,
        error: error.message,
        timestamp: new Date().toISOString()
      };
    }
  }
}

module.exports = new ClaudeRelayService();