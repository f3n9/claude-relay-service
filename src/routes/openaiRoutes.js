const express = require('express')
const axios = require('axios')
const router = express.Router()
const logger = require('../utils/logger')
const { authenticateApiKey } = require('../middleware/auth')
const claudeAccountService = require('../services/claudeAccountService')
const unifiedOpenAIScheduler = require('../services/unifiedOpenAIScheduler')
const openaiAccountService = require('../services/openaiAccountService')
const apiKeyService = require('../services/apiKeyService')
const crypto = require('crypto')

// 使用统一调度器选择 OpenAI 账户
async function getOpenAIAuthToken(apiKeyData, sessionId = null, requestedModel = null) {
  try {
    // 生成会话哈希（如果有会话ID）
    const sessionHash = sessionId
      ? crypto.createHash('sha256').update(sessionId).digest('hex')
      : null

    // 使用统一调度器选择账户
    const result = await unifiedOpenAIScheduler.selectAccountForApiKey(
      apiKeyData,
      sessionHash,
      requestedModel
    )

    if (!result || !result.accountId) {
      throw new Error('No available OpenAI account found')
    }

    // 获取账户详情
    const account = await openaiAccountService.getAccount(result.accountId)
    if (!account || !account.accessToken) {
      throw new Error(`OpenAI account ${result.accountId} has no valid accessToken`)
    }

    // 解密 accessToken
    const accessToken = claudeAccountService._decryptSensitiveData(account.accessToken)
    if (!accessToken) {
      throw new Error('Failed to decrypt OpenAI accessToken')
    }

    logger.info(`Selected OpenAI account: ${account.name} (${result.accountId})`)
    return {
      accessToken,
      accountId: result.accountId,
      accountName: account.name
    }
  } catch (error) {
    logger.error('Failed to get OpenAI auth token:', error)
    throw error
  }
}

router.post('/responses', authenticateApiKey, async (req, res) => {
  let upstream = null
  try {
    // 从中间件获取 API Key 数据
    const apiKeyData = req.apiKeyData || {}

    // 从请求头或请求体中提取会话 ID
    const sessionId =
      req.headers['session_id'] ||
      req.headers['x-session-id'] ||
      req.body?.session_id ||
      req.body?.conversation_id ||
      null

    // 从请求体中提取模型和流式标志
    const requestedModel = req.body?.model || null
    const isStream = req.body?.stream !== false // 默认为流式（兼容现有行为）

    // 使用调度器选择账户
    const { accessToken, accountId } = await getOpenAIAuthToken(
      apiKeyData,
      sessionId,
      requestedModel
    )
    // 基于白名单构造上游所需的请求头，确保键为小写且值受控
    const incoming = req.headers || {}

    const allowedKeys = ['version', 'openai-beta', 'session_id']

    const headers = {}
    for (const key of allowedKeys) {
      if (incoming[key] !== undefined) {
        headers[key] = incoming[key]
      }
    }

    // 覆盖或新增必要头部
    headers['authorization'] = `Bearer ${accessToken}`
    headers['chatgpt-account-id'] = accountId
    headers['host'] = 'chatgpt.com'
    headers['accept'] = isStream ? 'text/event-stream' : 'application/json'
    headers['content-type'] = 'application/json'
    req.body['store'] = false

    // 根据 stream 参数决定请求类型
    if (isStream) {
      // 流式请求
      upstream = await axios.post('https://chatgpt.com/backend-api/codex/responses', req.body, {
        headers,
        responseType: 'stream',
        timeout: 60000,
        validateStatus: () => true
      })
    } else {
      // 非流式请求
      upstream = await axios.post('https://chatgpt.com/backend-api/codex/responses', req.body, {
        headers,
        timeout: 60000,
        validateStatus: () => true
      })
    }
    res.status(upstream.status)

    if (isStream) {
      // 流式响应头
      res.setHeader('Content-Type', 'text/event-stream')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('X-Accel-Buffering', 'no')
    } else {
      // 非流式响应头
      res.setHeader('Content-Type', 'application/json')
    }

    // 透传关键诊断头，避免传递不安全或与传输相关的头
    const passThroughHeaderKeys = ['openai-version', 'x-request-id', 'openai-processing-ms']
    for (const key of passThroughHeaderKeys) {
      const val = upstream.headers?.[key]
      if (val !== undefined) {
        res.setHeader(key, val)
      }
    }

    if (isStream) {
      // 立即刷新响应头，开始 SSE
      if (typeof res.flushHeaders === 'function') {
        res.flushHeaders()
      }
    }

    // 处理响应并捕获 usage 数据和真实的 model
    let buffer = ''
    let usageData = null
    let actualModel = null
    let usageReported = false

    if (!isStream) {
      // 非流式响应处理
      try {
        logger.info(`📄 Processing OpenAI non-stream response for model: ${requestedModel}`)

        // 直接获取完整响应
        const responseData = upstream.data

        // 从响应中获取实际的 model 和 usage
        actualModel = responseData.model || requestedModel || 'gpt-4'
        usageData = responseData.usage

        logger.debug(`📊 Non-stream response - Model: ${actualModel}, Usage:`, usageData)

        // 记录使用统计
        if (usageData) {
          const inputTokens = usageData.input_tokens || usageData.prompt_tokens || 0
          const outputTokens = usageData.output_tokens || usageData.completion_tokens || 0
          const cacheCreateTokens = usageData.input_tokens_details?.cache_creation_tokens || 0
          const cacheReadTokens = usageData.input_tokens_details?.cached_tokens || 0

          await apiKeyService.recordUsage(
            apiKeyData.id,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            actualModel,
            accountId
          )

          logger.info(
            `📊 Recorded OpenAI non-stream usage - Input: ${inputTokens}, Output: ${outputTokens}, Total: ${usageData.total_tokens || inputTokens + outputTokens}, Model: ${actualModel}`
          )
        }

        // 返回响应
        res.json(responseData)
        return
      } catch (error) {
        logger.error('Failed to process non-stream response:', error)
        if (!res.headersSent) {
          res.status(500).json({ error: { message: 'Failed to process response' } })
        }
        return
      }
    }

    // 解析 SSE 事件以捕获 usage 数据和 model
    const parseSSEForUsage = (data) => {
      const lines = data.split('\n')

      for (const line of lines) {
        if (line.startsWith('event: response.completed')) {
          // 下一行应该是数据
          continue
        }

        if (line.startsWith('data: ')) {
          try {
            const jsonStr = line.slice(6) // 移除 'data: ' 前缀
            const eventData = JSON.parse(jsonStr)

            // 检查是否是 response.completed 事件
            if (eventData.type === 'response.completed' && eventData.response) {
              // 从响应中获取真实的 model
              if (eventData.response.model) {
                actualModel = eventData.response.model
                logger.debug(`📊 Captured actual model: ${actualModel}`)
              }

              // 获取 usage 数据
              if (eventData.response.usage) {
                usageData = eventData.response.usage
                logger.debug('📊 Captured OpenAI usage data:', usageData)
              }
            }
          } catch (e) {
            // 忽略解析错误
          }
        }
      }
    }

    upstream.data.on('data', (chunk) => {
      try {
        const chunkStr = chunk.toString()

        // 转发数据给客户端
        if (!res.destroyed) {
          res.write(chunk)
        }

        // 同时解析数据以捕获 usage 信息
        buffer += chunkStr

        // 处理完整的 SSE 事件
        if (buffer.includes('\n\n')) {
          const events = buffer.split('\n\n')
          buffer = events.pop() || '' // 保留最后一个可能不完整的事件

          for (const event of events) {
            if (event.trim()) {
              parseSSEForUsage(event)
            }
          }
        }
      } catch (error) {
        logger.error('Error processing OpenAI stream chunk:', error)
      }
    })

    upstream.data.on('end', async () => {
      // 处理剩余的 buffer
      if (buffer.trim()) {
        parseSSEForUsage(buffer)
      }

      // 记录使用统计
      if (!usageReported && usageData) {
        try {
          const inputTokens = usageData.input_tokens || 0
          const outputTokens = usageData.output_tokens || 0
          const cacheCreateTokens = usageData.input_tokens_details?.cache_creation_tokens || 0
          const cacheReadTokens = usageData.input_tokens_details?.cached_tokens || 0

          // 使用响应中的真实 model，如果没有则使用请求中的 model，最后回退到默认值
          const modelToRecord = actualModel || requestedModel || 'gpt-4'

          await apiKeyService.recordUsage(
            apiKeyData.id,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            modelToRecord,
            accountId
          )

          logger.info(
            `📊 Recorded OpenAI usage - Input: ${inputTokens}, Output: ${outputTokens}, Total: ${usageData.total_tokens || inputTokens + outputTokens}, Model: ${modelToRecord} (actual: ${actualModel}, requested: ${requestedModel})`
          )
          usageReported = true
        } catch (error) {
          logger.error('Failed to record OpenAI usage:', error)
        }
      }

      res.end()
    })

    upstream.data.on('error', (err) => {
      logger.error('Upstream stream error:', err)
      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'Upstream stream error' } })
      } else {
        res.end()
      }
    })

    // 客户端断开时清理上游流
    const cleanup = () => {
      try {
        upstream.data?.unpipe?.(res)
        upstream.data?.destroy?.()
      } catch (_) {
        //
      }
    }
    req.on('close', cleanup)
    req.on('aborted', cleanup)
  } catch (error) {
    logger.error('Proxy to ChatGPT codex/responses failed:', error)
    const status = error.response?.status || 500
    const message = error.response?.data || error.message || 'Internal server error'
    if (!res.headersSent) {
      res.status(status).json({ error: { message } })
    }
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
    logger.error('Failed to get usage stats:', error)
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
    logger.error('Failed to get key info:', error)
    res.status(500).json({
      error: {
        message: 'Failed to retrieve API key information',
        type: 'api_error'
      }
    })
  }
})

module.exports = router
