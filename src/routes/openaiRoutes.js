const express = require('express')
const axios = require('axios')
const router = express.Router()
const logger = require('../utils/logger')
const { authenticateApiKey } = require('../middleware/auth')
const redis = require('../models/redis')
const claudeAccountService = require('../services/claudeAccountService')

// 选择一个可用的 OpenAI 账户，并返回解密后的 accessToken
async function getOpenAIAuthToken() {
  try {
    const accounts = await redis.getAllOpenAIAccounts()
    if (!accounts || accounts.length === 0) {
      throw new Error('No OpenAI accounts found in Redis')
    }

    // 简单选择策略：选择第一个启用并活跃的账户
    const candidate =
      accounts.find((a) => String(a.enabled) === 'true' && String(a.isActive) === 'true') ||
      accounts[0]

    if (!candidate || !candidate.accessToken) {
      throw new Error('No valid OpenAI account with accessToken')
    }

    const accessToken = claudeAccountService._decryptSensitiveData(candidate.accessToken)
    if (!accessToken) {
      throw new Error('Failed to decrypt OpenAI accessToken')
    }
    return { accessToken, accountId: candidate.accountId || 'unknown' }
  } catch (error) {
    logger.error('Failed to get OpenAI auth token from Redis:', error)
    throw error
  }
}

router.post('/responses', authenticateApiKey, async (req, res) => {
  let upstream = null
  try {
    const { accessToken, accountId } = await getOpenAIAuthToken()
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
    headers['accept'] = 'text/event-stream'
    headers['content-type'] = 'application/json'
    req.body['store'] = false
    // 使用流式转发，保持与上游一致
    upstream = await axios.post('https://chatgpt.com/backend-api/codex/responses', req.body, {
      headers,
      responseType: 'stream',
      timeout: 60000,
      validateStatus: () => true
    })
    res.status(upstream.status)
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')

    // 透传关键诊断头，避免传递不安全或与传输相关的头
    const passThroughHeaderKeys = ['openai-version', 'x-request-id', 'openai-processing-ms']
    for (const key of passThroughHeaderKeys) {
      const val = upstream.headers?.[key]
      if (val !== undefined) {
        res.setHeader(key, val)
      }
    }

    // 立即刷新响应头，开始 SSE
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders()
    }

    upstream.data.on('error', (err) => {
      logger.error('Upstream stream error:', err)
      if (!res.headersSent) {
        res.status(502).json({ error: { message: 'Upstream stream error' } })
      } else {
        res.end()
      }
    })

    upstream.data.pipe(res)

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

module.exports = router
