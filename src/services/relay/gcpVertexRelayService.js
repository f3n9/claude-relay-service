const axios = require('axios')
const { v4: uuidv4 } = require('uuid')
const config = require('../../../config/config')
const logger = require('../../utils/logger')
const gcpVertexAccountService = require('../account/gcpVertexAccountService')
const ProxyHelper = require('../../utils/proxyHelper')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')
const userMessageQueueService = require('../userMessageQueueService')
const { filterForClaude } = require('../../utils/headerFilter')
const { isStreamWritable } = require('../../utils/streamHelper')

// structuredClone polyfill for Node < 17
const safeClone =
  typeof structuredClone === 'function' ? structuredClone : (obj) => JSON.parse(JSON.stringify(obj))

class GcpVertexRelayService {
  constructor() {
    this.defaultUserAgent = 'claude-relay-service/2.0'
  }

  _buildEndpoint(account, modelId, isStream) {
    const projectId = account.projectId
    const location = account.location || config.gcpVertex?.defaultLocation || 'global'
    const encodedModel = encodeURIComponent(modelId)
    const action = isStream ? 'streamRawPredict' : 'rawPredict'
    return `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/anthropic/models/${encodedModel}:${action}`
  }

  _buildPayload(requestBody, account) {
    const payload = safeClone(requestBody || {})
    delete payload.model
    delete payload.stream

    if (!payload.anthropic_version) {
      payload.anthropic_version =
        account.anthropicVersion || config.gcpVertex?.anthropicVersion || 'vertex-2023-10-16'
    }

    return payload
  }

  _buildHeaders(clientHeaders, accessToken, isStream) {
    const filtered = filterForClaude(clientHeaders)
    const userAgent = filtered['user-agent'] || filtered['User-Agent'] || this.defaultUserAgent

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'User-Agent': userAgent
    }

    if (isStream) {
      headers.Accept = 'text/event-stream'
    }

    return headers
  }

  async relayRequest(
    requestBody,
    apiKeyData,
    clientRequest,
    clientResponse,
    clientHeaders,
    accountId,
    options = {}
  ) {
    let queueLockAcquired = false
    let queueRequestId = null

    try {
      if (userMessageQueueService.isUserMessageRequest(requestBody)) {
        if (!accountId) {
          throw new Error('accountId missing for queue lock')
        }
        const queueResult = await userMessageQueueService.acquireQueueLock(accountId)
        if (!queueResult.acquired && !queueResult.skipped) {
          const isBackendError = queueResult.error === 'queue_backend_error'
          const errorCode = isBackendError ? 'QUEUE_BACKEND_ERROR' : 'QUEUE_TIMEOUT'
          const errorType = isBackendError ? 'queue_backend_error' : 'queue_timeout'
          const errorMessage = isBackendError
            ? 'Queue service temporarily unavailable, please retry later'
            : 'User message queue wait timeout, please retry later'
          const statusCode = isBackendError ? 500 : 503

          logger.warn(
            `📬 User message queue ${errorType} for vertex account ${accountId}, key: ${apiKeyData.name}`
          )
          return {
            statusCode,
            headers: {
              'Content-Type': 'application/json',
              'x-user-message-queue-error': errorType
            },
            body: JSON.stringify({
              type: 'error',
              error: { type: errorType, code: errorCode, message: errorMessage }
            }),
            accountId
          }
        }
        if (queueResult.acquired && !queueResult.skipped) {
          queueLockAcquired = true
          queueRequestId = queueResult.requestId
        }
      }

      const account = await gcpVertexAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('GCP Vertex account not found')
      }

      const modelId = account.defaultModel || requestBody.model
      if (!modelId) {
        throw new Error('Model is required for GCP Vertex request')
      }

      const accessToken = await gcpVertexAccountService.getAccessToken(account)
      const endpoint = this._buildEndpoint(account, modelId, false)
      const payload = this._buildPayload(requestBody, account)
      const headers = this._buildHeaders(clientHeaders, accessToken, false)
      const proxyAgent = account.proxy ? ProxyHelper.createProxyAgent(account.proxy) : null

      const response = await axios.post(endpoint, payload, {
        headers,
        timeout: config.requestTimeout || 600000,
        httpsAgent: proxyAgent || undefined,
        proxy: false,
        validateStatus: () => true
      })

      if (response.status === 429) {
        await gcpVertexAccountService.markAccountRateLimited(accountId)
      }

      if (response.status === 401 || response.status === 403 || response.status >= 500) {
        await upstreamErrorHelper.markTempUnavailable(accountId, 'claude-vertex', response.status)
      }

      const body = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)

      return {
        statusCode: response.status,
        headers: response.headers,
        body,
        accountId
      }
    } finally {
      if (queueLockAcquired && queueRequestId) {
        await userMessageQueueService.releaseQueueLock(accountId, queueRequestId)
      }
    }
  }

  async relayStreamRequestWithUsageCapture(
    requestBody,
    apiKeyData,
    clientResponse,
    clientHeaders,
    usageCallback,
    accountId,
    streamTransformer = null
  ) {
    let queueLockAcquired = false
    let queueRequestId = null
    const requestId = uuidv4()

    try {
      if (userMessageQueueService.isUserMessageRequest(requestBody)) {
        if (!accountId) {
          throw new Error('accountId missing for queue lock')
        }
        const queueResult = await userMessageQueueService.acquireQueueLock(accountId)
        if (!queueResult.acquired && !queueResult.skipped) {
          const isBackendError = queueResult.error === 'queue_backend_error'
          const errorCode = isBackendError ? 'QUEUE_BACKEND_ERROR' : 'QUEUE_TIMEOUT'
          const errorType = isBackendError ? 'queue_backend_error' : 'queue_timeout'
          const errorMessage = isBackendError
            ? 'Queue service temporarily unavailable, please retry later'
            : 'User message queue wait timeout, please retry later'
          const statusCode = isBackendError ? 500 : 503

          clientResponse.setHeader('Content-Type', 'application/json')
          clientResponse.status(statusCode)
          clientResponse.end(
            JSON.stringify({
              type: 'error',
              error: { type: errorType, code: errorCode, message: errorMessage }
            })
          )
          return
        }
        if (queueResult.acquired && !queueResult.skipped) {
          queueLockAcquired = true
          queueRequestId = queueResult.requestId
        }
      }

      const account = await gcpVertexAccountService.getAccount(accountId)
      if (!account) {
        throw new Error('GCP Vertex account not found')
      }

      const modelId = account.defaultModel || requestBody.model
      if (!modelId) {
        throw new Error('Model is required for GCP Vertex request')
      }

      const accessToken = await gcpVertexAccountService.getAccessToken(account)
      const endpoint = this._buildEndpoint(account, modelId, true)
      const payload = this._buildPayload(requestBody, account)
      const headers = this._buildHeaders(clientHeaders, accessToken, true)
      const proxyAgent = account.proxy ? ProxyHelper.createProxyAgent(account.proxy) : null

      logger.info(
        `📡 Streaming GCP Vertex request for key: ${apiKeyData.name || apiKeyData.id}, account: ${
          account.name
        } (${accountId}), request: ${requestId}`
      )

      const response = await axios.post(endpoint, payload, {
        headers,
        responseType: 'stream',
        timeout: config.requestTimeout || 600000,
        httpsAgent: proxyAgent || undefined,
        proxy: false,
        validateStatus: () => true
      })

      if (response.status === 429) {
        await gcpVertexAccountService.markAccountRateLimited(accountId)
      }

      if (response.status === 401 || response.status === 403 || response.status >= 500) {
        await upstreamErrorHelper.markTempUnavailable(accountId, 'claude-vertex', response.status)
      }

      if (response.status >= 400) {
        let errorBody = ''
        response.data.on('data', (chunk) => {
          errorBody += chunk.toString()
        })
        response.data.on('end', () => {
          clientResponse.status(response.status)
          clientResponse.setHeader('Content-Type', 'application/json')
          clientResponse.end(errorBody)
        })
        return
      }

      clientResponse.setHeader('Content-Type', 'text/event-stream')
      clientResponse.setHeader('Cache-Control', 'no-cache')
      clientResponse.setHeader('Connection', 'keep-alive')

      let buffer = ''
      let currentUsage = {}
      const usageEvents = []

      const flushUsage = () => {
        if (
          currentUsage &&
          currentUsage.input_tokens !== undefined &&
          currentUsage.output_tokens !== undefined
        ) {
          const usagePayload = {
            ...currentUsage,
            model: currentUsage.model || modelId,
            accountId
          }
          usageEvents.push(usagePayload)
          if (typeof usageCallback === 'function') {
            usageCallback(usagePayload)
          }
          currentUsage = {}
        }
      }

      response.data.on('data', (chunk) => {
        const chunkStr = chunk.toString('utf8')
        if (isStreamWritable(clientResponse)) {
          if (streamTransformer) {
            const transformed = streamTransformer(chunkStr)
            if (transformed) {
              clientResponse.write(transformed)
            }
          } else {
            clientResponse.write(chunkStr)
          }
        }
        buffer += chunkStr

        let index
        while ((index = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line || !line.startsWith('data:')) {
            continue
          }
          const dataStr = line.slice(5).trim()
          if (!dataStr || dataStr === '[DONE]') {
            continue
          }
          try {
            const data = JSON.parse(dataStr)
            if (data.type === 'message_start' && data.message?.usage) {
              currentUsage.input_tokens = data.message.usage.input_tokens || 0
              currentUsage.cache_creation_input_tokens =
                data.message.usage.cache_creation_input_tokens || 0
              currentUsage.cache_read_input_tokens = data.message.usage.cache_read_input_tokens || 0
              if (data.message?.usage?.cache_creation) {
                currentUsage.cache_creation = data.message.usage.cache_creation
              }
              if (data.message?.model) {
                currentUsage.model = data.message.model
              }
            }
            if (data.type === 'message_delta' && data.usage) {
              currentUsage.output_tokens = data.usage.output_tokens || 0
              flushUsage()
            }
          } catch {
            // ignore parse errors
          }
        }
      })

      response.data.on('end', () => {
        flushUsage()
        if (isStreamWritable(clientResponse)) {
          clientResponse.end()
        }
        logger.debug('🌊 GCP Vertex stream completed')
      })

      response.data.on('error', (error) => {
        logger.error('❌ GCP Vertex stream error:', error)
        if (isStreamWritable(clientResponse)) {
          clientResponse.end()
        }
      })
    } finally {
      if (queueLockAcquired && queueRequestId) {
        await userMessageQueueService.releaseQueueLock(accountId, queueRequestId)
      }
    }
  }
}

module.exports = new GcpVertexRelayService()
