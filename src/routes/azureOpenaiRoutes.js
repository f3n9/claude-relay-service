const express = require('express')
const router = express.Router()
const logger = require('../utils/logger')
const { authenticateApiKey } = require('../middleware/auth')
const azureOpenaiAccountService = require('../services/azureOpenaiAccountService')
const azureOpenaiRelayService = require('../services/azureOpenaiRelayService')
const apiKeyService = require('../services/apiKeyService')
const crypto = require('crypto')

// 支持的模型列表 - 基于真实的 Azure OpenAI 模型
const ALLOWED_MODELS = {
  CHAT_MODELS: [
    'gpt-4',
    'gpt-4-turbo',
    'gpt-4o',
    'gpt-4o-mini',
    'gpt-5',
    'gpt-5-mini',
    'gpt-35-turbo',
    'gpt-35-turbo-16k'
  ],
  CODEX_MODELS: ['codex-mini', 'codex-mini-latest'] // 保留 codex-mini 支持
}

const ALL_ALLOWED_MODELS = [...ALLOWED_MODELS.CHAT_MODELS, ...ALLOWED_MODELS.CODEX_MODELS]

// Azure OpenAI 稳定 API 版本
const AZURE_API_VERSION = '2024-02-01'

// 原子使用统计报告器
class AtomicUsageReporter {
  constructor() {
    this.reportedUsage = new Set()
    this.pendingReports = new Map()
  }

  async reportOnce(requestId, usageData, apiKeyId, modelToRecord, accountId) {
    if (this.reportedUsage.has(requestId)) {
      logger.debug(`Usage already reported for request: ${requestId}`)
      return false
    }

    // 防止并发重复报告
    if (this.pendingReports.has(requestId)) {
      return this.pendingReports.get(requestId)
    }

    const reportPromise = this._performReport(
      requestId,
      usageData,
      apiKeyId,
      modelToRecord,
      accountId
    )
    this.pendingReports.set(requestId, reportPromise)

    try {
      const result = await reportPromise
      this.reportedUsage.add(requestId)
      return result
    } finally {
      this.pendingReports.delete(requestId)
      // 清理过期的已报告记录
      setTimeout(() => this.reportedUsage.delete(requestId), 60 * 1000) // 1分钟后清理
    }
  }

  async _performReport(requestId, usageData, apiKeyId, modelToRecord, accountId) {
    try {
      const inputTokens = usageData.prompt_tokens || usageData.input_tokens || 0
      const outputTokens = usageData.completion_tokens || usageData.output_tokens || 0
      const cacheCreateTokens =
        usageData.prompt_tokens_details?.cache_creation_tokens ||
        usageData.input_tokens_details?.cache_creation_tokens ||
        0
      const cacheReadTokens =
        usageData.prompt_tokens_details?.cached_tokens ||
        usageData.input_tokens_details?.cached_tokens ||
        0

      await apiKeyService.recordUsage(
        apiKeyId,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        modelToRecord,
        accountId
      )

      // 同步更新 Azure 账户的 lastUsedAt 和累计使用量
      try {
        const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens
        if (accountId) {
          await azureOpenaiAccountService.updateAccountUsage(accountId, totalTokens)
        }
      } catch (acctErr) {
        logger.warn(`Failed to update Azure account usage for ${accountId}: ${acctErr.message}`)
      }

      logger.info(
        `📊 Recorded Azure OpenAI usage - Request: ${requestId}, Input: ${inputTokens}, Output: ${outputTokens}, Model: ${modelToRecord}`
      )
      return true
    } catch (error) {
      logger.error(`Failed to record usage for request ${requestId}:`, error)
      throw error
    }
  }

  getStats() {
    return {
      reportedCount: this.reportedUsage.size,
      pendingCount: this.pendingReports.size
    }
  }
}

const usageReporter = new AtomicUsageReporter()

// Azure 端点验证 (未使用，但保留供未来使用)
function _validateAzureEndpoint(endpoint) {
  if (!endpoint) {
    return false
  }
  const azurePattern = /^https:\/\/[\w-]+\.openai\.azure\.com$/
  return azurePattern.test(endpoint)
}

// Azure 部署验证 (未使用，但保留供未来使用)
async function _validateAzureDeployment(
  endpoint,
  deploymentName,
  apiKey,
  apiVersion = AZURE_API_VERSION
) {
  try {
    const axios = require('axios')
    const response = await axios.get(
      `${endpoint}/openai/deployments/${deploymentName}?api-version=${apiVersion}`,
      {
        headers: { 'api-key': apiKey },
        timeout: 10000
      }
    )
    return response.status === 200
  } catch (error) {
    logger.warn(`Azure deployment validation failed for ${deploymentName}:`, error.message)
    return false
  }
}

// Azure 错误规范化
function normalizeAzureError(error) {
  const errorData = error.response?.data

  if (errorData?.error?.code === 'DeploymentNotFound') {
    return {
      error: {
        message: 'Model deployment not found',
        type: 'invalid_request_error',
        code: 'deployment_not_found'
      }
    }
  }

  if (errorData?.error?.code === 'RateLimitExceeded') {
    return {
      error: {
        message: 'Rate limit exceeded for Azure OpenAI',
        type: 'rate_limit_error',
        code: 'rate_limit_exceeded'
      }
    }
  }

  if (errorData?.error?.code === 'InvalidAuthentication') {
    return {
      error: {
        message: 'Invalid Azure OpenAI API key',
        type: 'authentication_error',
        code: 'invalid_api_key'
      }
    }
  }

  // 默认错误处理
  return {
    error: {
      message: errorData?.error?.message || error.message || 'Azure OpenAI request failed',
      type: errorData?.error?.type || 'api_error',
      code: errorData?.error?.code || null
    }
  }
}

// 模型验证函数
function validateAndNormalizeModel(requestedModel, endpoint = 'chat/completions') {
  if (!requestedModel) {
    return 'gpt-5-mini'
  }

  // 移除可能的前缀
  let normalizedModel = requestedModel.replace(/^azure[/:]/, '')

  // 处理一些常见的模型别名
  const modelAliases = {
    'gpt-4o-latest': 'gpt-4o',
    'gpt-4-latest': 'gpt-4',
    'gpt-35-turbo-latest': 'gpt-35-turbo',
    'gpt-3.5-turbo': 'gpt-35-turbo',
    'gpt-3.5-turbo-16k': 'gpt-35-turbo-16k'
  }

  normalizedModel = modelAliases[normalizedModel] || normalizedModel

  // 验证模型是否在允许列表中
  if (!ALL_ALLOWED_MODELS.includes(normalizedModel)) {
    logger.warn(`Invalid model requested: ${requestedModel}, using default`)
    return 'gpt-5-mini'
  }

  return normalizedModel
}

// 安全的会话哈希生成
function generateSecureSessionHash(sessionId, config) {
  if (!sessionId) {
    return null
  }

  const sessionSalt = config?.security?.sessionSalt || 'default-session-salt'
  return crypto.createHmac('sha256', sessionSalt).update(sessionId).digest('hex')
}

// 使用 Azure OpenAI 服务选择账户 - 增强安全性和详细日志
async function getAzureOpenAIAccount(apiKeyData, sessionId = null, requestedModel = null) {
  const debugPrefix = `🔍 Azure Account Selection`
  logger.info(`${debugPrefix}: Starting account selection`, {
    apiKeyId: apiKeyData.id,
    apiKeyName: apiKeyData.name,
    sessionId: sessionId ? `${sessionId.substring(0, 8)}...` : null,
    requestedModel
  })

  try {
    const config = require('../../config/config')
    // 生成安全的会话哈希
    const sessionHash = generateSecureSessionHash(sessionId, config)
    logger.debug(`${debugPrefix}: Generated session hash`, {
      sessionId: sessionId ? 'present' : 'null',
      sessionHash: sessionHash ? `${sessionHash.substring(0, 8)}...` : null
    })

    // 选择可用账户
    logger.info(`${debugPrefix}: Attempting to select available account`)
    const account = await azureOpenaiAccountService.selectAvailableAccount(
      apiKeyData.id,
      sessionHash,
      requestedModel
    )

    if (!account) {
      logger.error(`${debugPrefix}: No account returned from selectAvailableAccount`)
      throw new Error('No available Azure OpenAI account found - account is null')
    }

    if (!account.apiKey) {
      logger.error(`${debugPrefix}: Account found but missing API key`, {
        accountId: account.id,
        accountName: account.name,
        hasEndpoint: !!account.azureEndpoint
      })
      throw new Error('No available Azure OpenAI account found - missing API key')
    }

    logger.info(`${debugPrefix}: Successfully selected account`, {
      accountId: account.id,
      accountName: account.name,
      azureEndpoint: account.azureEndpoint,
      deploymentName: account.deploymentName,
      apiVersion: account.apiVersion,
      hasApiKey: !!account.apiKey,
      hasProxy: !!account.proxy
    })
    return account
  } catch (error) {
    logger.error(`${debugPrefix}: Failed to get Azure OpenAI account`, {
      error: error.message,
      stack: error.stack,
      apiKeyId: apiKeyData.id
    })
    throw error
  }
}

// 通用的 Azure OpenAI 端点处理器
async function handleAzureOpenAIEndpoint(req, res, options = {}) {
  const { endpoint = 'chat/completions', defaultModel = 'gpt-5-mini', defaultStream = false } = options

  // 生成请求ID用于全程跟踪
  const requestId = `azure_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
  const debugPrefix = `🔄 Azure Request [${requestId}]`

  logger.info(`${debugPrefix}: Starting Azure OpenAI endpoint handler`, {
    endpoint,
    method: req.method,
    url: req.url,
    defaultModel,
    defaultStream,
    userAgent: req.headers['user-agent']?.substring(0, 50),
    contentType: req.headers['content-type']
  })

  try {
    // 从中间件获取 API Key 数据
    const apiKeyData = req.apiKey || {}
    logger.info(`${debugPrefix}: API Key data retrieved`, {
      hasApiKey: !!apiKeyData,
      apiKeyId: apiKeyData.id,
      apiKeyName: apiKeyData.name,
      apiKeyType: apiKeyData.type
    })

    // 从请求头或请求体中提取会话 ID
    const sessionId =
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      req.body?.session_id ||
      req.body?.conversation_id ||
      null

    logger.debug(`${debugPrefix}: Session information`, {
      sessionId: sessionId ? `${sessionId.substring(0, 8)}...` : null,
      hasSessionHeaders: !!(req.headers['session_id'] || req.headers['x-session-id']),
      hasSessionBody: !!(req.body?.session_id || req.body?.conversation_id)
    })

    // 验证和规范化模型
    const requestedModel = validateAndNormalizeModel(req.body?.model || defaultModel, endpoint)
    // Determine stream mode: respect explicit boolean, otherwise use endpoint default
    const isStream =
      typeof req.body?.stream === 'boolean' ? req.body.stream : Boolean(defaultStream)

    logger.info(`${debugPrefix}: Request parameters`, {
      originalModel: req.body?.model,
      requestedModel,
      isStream,
      endpoint,
      bodySize: JSON.stringify(req.body || {}).length
    })

    // 选择账户
    logger.info(`${debugPrefix}: Selecting Azure OpenAI account`)
    const account = await getAzureOpenAIAccount(apiKeyData, sessionId, requestedModel)

    logger.info(`${debugPrefix}: Selected Azure account details`, {
      accountId: account.id,
      accountName: account.name,
      azureEndpoint: account.azureEndpoint,
      deploymentName: account.deploymentName,
      apiVersion: account.apiVersion,
      hasProxy: !!account.proxy,
      proxyType: account.proxy?.type || 'none'
    })

    // 处理请求
    logger.info(`${debugPrefix}: Making upstream request to Azure OpenAI`)
    const upstreamResponse = await azureOpenaiRelayService.handleAzureOpenAIRequest({
      account,
      requestBody: req.body,
      headers: req.headers,
      isStream,
      endpoint
    })

    logger.info(`${debugPrefix}: Received upstream response`, {
      status: upstreamResponse.status,
      statusText: upstreamResponse.statusText,
      hasData: !!upstreamResponse.data,
      responseHeaders: Object.keys(upstreamResponse.headers || {})
    })

    // 设置响应状态码
    res.status(upstreamResponse.status)

    if (isStream) {
      // 流式响应处理
      await azureOpenaiRelayService.handleStreamResponse(upstreamResponse, res, {
        onEnd: async ({ usageData, actualModel }) => {
          if (usageData) {
            const modelToRecord = actualModel || requestedModel
            await usageReporter.reportOnce(
              requestId,
              usageData,
              apiKeyData.id,
              modelToRecord,
              account.id
            )
          }
        }
      })
    } else {
      // 非流式响应处理
      const { usageData, actualModel } = azureOpenaiRelayService.handleNonStreamResponse(
        upstreamResponse,
        res
      )

      // 记录使用统计
      if (usageData) {
        const modelToRecord = actualModel || requestedModel
        await usageReporter.reportOnce(
          requestId,
          usageData,
          apiKeyData.id,
          modelToRecord,
          account.id
        )
      }
    }
  } catch (error) {
    logger.error(`Azure OpenAI ${endpoint} request failed:`, error)
    const status = error.response?.status || 500

    // 使用 Azure 特定的错误规范化
    const errorResponse = normalizeAzureError(error)

    if (!res.headersSent) {
      res.status(status).json(errorResponse)
    }
  }
}

// Chat Completions 端点 (模拟 OpenAI API) - 使用通用处理器
router.post('/chat/completions', authenticateApiKey, (req, res) =>
  handleAzureOpenAIEndpoint(req, res, {
    endpoint: 'chat/completions',
    defaultModel: 'gpt-5-mini',
    defaultStream: false,
    allowedModels: ALLOWED_MODELS.CHAT_MODELS
  })
)

// Codex Responses 端点 (支持 gpt-5, codex-mini 模型) - 使用通用处理器
router.post('/responses', authenticateApiKey, (req, res) =>
  handleAzureOpenAIEndpoint(req, res, {
    endpoint: 'responses',
    defaultModel: 'gpt-5-mini',
    defaultStream: true, // Codex默认为流式
    allowedModels: ALL_ALLOWED_MODELS
  })
)

// Models 端点 (返回支持的模型列表) - 动态生成
router.get('/models', authenticateApiKey, async (req, res) => {
  try {
    // 动态生成支持的模型列表
    const currentTime = Math.floor(Date.now() / 1000)

    const modelData = ALL_ALLOWED_MODELS.map((modelId) => ({
      id: modelId,
      object: 'model',
      created: currentTime,
      owned_by: 'azure-openai',
      permission: [],
      root: modelId,
      parent: null
    }))

    const models = {
      object: 'list',
      data: modelData
    }

    res.json(models)
  } catch (error) {
    logger.error('Failed to get Azure OpenAI models:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve models',
        type: 'api_error'
      }
    })
  }
})

// 使用情况统计端点
router.get('/usage', authenticateApiKey, async (req, res) => {
  try {
    const { usage } = req.apiKey

    res.json({
      object: 'usage',
      total_tokens: usage.total.tokens,
      total_requests: usage.total.requests,
      daily_tokens: usage.daily.tokens,
      daily_requests: usage.daily.requests,
      monthly_tokens: usage.monthly.tokens,
      monthly_requests: usage.monthly.requests
    })
  } catch (error) {
    logger.error('Failed to get Azure OpenAI usage stats:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve usage statistics',
        type: 'api_error'
      }
    })
  }
})

// API Key 信息端点
router.get('/key-info', authenticateApiKey, async (req, res) => {
  try {
    const keyData = req.apiKey
    res.json({
      id: keyData.id,
      name: keyData.name,
      description: keyData.description,
      permissions: keyData.permissions || 'all',
      token_limit: keyData.tokenLimit,
      tokens_used: keyData.usage.total.tokens,
      tokens_remaining:
        keyData.tokenLimit > 0
          ? Math.max(0, keyData.tokenLimit - keyData.usage.total.tokens)
          : null,
      rate_limit: {
        window: keyData.rateLimitWindow,
        requests: keyData.rateLimitRequests
      },
      usage: {
        total: keyData.usage.total,
        daily: keyData.usage.daily,
        monthly: keyData.usage.monthly
      }
    })
  } catch (error) {
    logger.error('Failed to get Azure OpenAI key info:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve API key information',
        type: 'api_error'
      }
    })
  }
})

module.exports = router
