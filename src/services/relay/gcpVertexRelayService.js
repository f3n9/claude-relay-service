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
    const { projectId } = account
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
    const skipQueueLock = options.skipQueueLock === true
    const abortController = new AbortController()
    let clientDisconnected = false

    const handleClientDisconnect = () => {
      clientDisconnected = true
      logger.info('🔌 Client disconnected, aborting GCP Vertex non-stream request')
      if (!abortController.signal.aborted) {
        abortController.abort()
      }
    }

    const cleanupClientListeners = () => {
      clientRequest?.removeListener('close', handleClientDisconnect)
      clientRequest?.removeListener('aborted', handleClientDisconnect)
      clientResponse?.removeListener('close', handleClientDisconnect)
      clientResponse?.removeListener('aborted', handleClientDisconnect)
    }

    clientRequest?.once('close', handleClientDisconnect)
    clientRequest?.once('aborted', handleClientDisconnect)
    clientResponse?.once('close', handleClientDisconnect)
    clientResponse?.once('aborted', handleClientDisconnect)

    try {
      if (!skipQueueLock && userMessageQueueService.isUserMessageRequest(requestBody)) {
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
        validateStatus: () => true,
        signal: abortController.signal
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
    } catch (error) {
      if (
        clientDisconnected ||
        abortController.signal.aborted ||
        error.code === 'ERR_CANCELED' ||
        error.name === 'CanceledError' ||
        error.name === 'AbortError'
      ) {
        logger.info('🔌 GCP Vertex non-stream request aborted due to client disconnect')
        throw new Error('Client disconnected')
      }

      throw error
    } finally {
      cleanupClientListeners()
      if (queueLockAcquired && queueRequestId) {
        try {
          await userMessageQueueService.releaseQueueLock(accountId, queueRequestId)
        } catch (releaseError) {
          logger.error(
            `❌ Failed to release user message queue lock for GCP Vertex account ${accountId}:`,
            releaseError.message
          )
        }
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
    const abortController = new AbortController()
    let upstreamStream = null
    let streamFinished = false

    const releaseQueueLockSafe = async (context = 'finally') => {
      if (!queueLockAcquired || !queueRequestId) {
        return
      }
      try {
        await userMessageQueueService.releaseQueueLock(accountId, queueRequestId)
        logger.debug(
          `📬 Released GCP Vertex stream queue lock (${context}) for account ${accountId}, requestId: ${queueRequestId}`
        )
      } catch (releaseError) {
        logger.error(
          `❌ Failed to release user message queue lock for GCP Vertex stream account ${accountId} (${context}):`,
          releaseError.message
        )
      } finally {
        queueLockAcquired = false
        queueRequestId = null
      }
    }

    const cleanupClientListeners = () => {
      clientResponse.removeListener('close', handleClientDisconnect)
      clientResponse.removeListener('aborted', handleClientDisconnect)
    }

    const handleClientDisconnect = () => {
      if (streamFinished) {
        return
      }
      streamFinished = true
      logger.info('🔌 Client disconnected, aborting GCP Vertex stream request')
      if (!abortController.signal.aborted) {
        abortController.abort()
      }
      if (upstreamStream && typeof upstreamStream.destroy === 'function') {
        upstreamStream.destroy()
      }
      cleanupClientListeners()
    }

    clientResponse.on('close', handleClientDisconnect)
    clientResponse.on('aborted', handleClientDisconnect)

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
        validateStatus: () => true,
        signal: abortController.signal
      })
      upstreamStream = response.data

      // 📬 上游已开始响应（已收到响应头），立即释放队列锁，避免长流式阻塞后续请求
      await releaseQueueLockSafe('after upstream stream start')

      if (response.status === 429) {
        await gcpVertexAccountService.markAccountRateLimited(accountId)
      }

      if (response.status === 401 || response.status === 403 || response.status >= 500) {
        await upstreamErrorHelper.markTempUnavailable(accountId, 'claude-vertex', response.status)
      }

      if (response.status >= 400) {
        let errorBody = ''
        await new Promise((resolve) => {
          let settled = false
          const settle = () => {
            if (settled) {
              return
            }
            settled = true
            resolve()
          }

          response.data.on('data', (chunk) => {
            errorBody += chunk.toString()
          })

          response.data.on('end', () => {
            streamFinished = true
            cleanupClientListeners()
            if (isStreamWritable(clientResponse)) {
              clientResponse.status(response.status)
              clientResponse.setHeader('Content-Type', 'application/json')
              clientResponse.end(errorBody)
            }
            settle()
          })

          response.data.on('error', (error) => {
            streamFinished = true
            cleanupClientListeners()
            logger.error('❌ GCP Vertex error stream interrupted:', error)
            if (isStreamWritable(clientResponse)) {
              clientResponse.status(response.status)
              clientResponse.setHeader('Content-Type', 'application/json')
              clientResponse.end(
                errorBody ||
                  JSON.stringify({
                    error: 'Upstream error stream interrupted',
                    message: error.message
                  })
              )
            }
            settle()
          })
        })
        return
      }

      clientResponse.setHeader('Content-Type', 'text/event-stream')
      clientResponse.setHeader('Cache-Control', 'no-cache')
      const existingConnection = clientResponse.getHeader
        ? clientResponse.getHeader('Connection')
        : null
      if (existingConnection) {
        logger.debug(`🔌 [Vertex Stream] Preserving existing Connection header: ${existingConnection}`)
      } else {
        clientResponse.setHeader('Connection', 'keep-alive')
      }

      let buffer = ''
      const collectedUsage = {}

      const emitUsageOnce = () => {
        if (
          collectedUsage.input_tokens !== undefined &&
          collectedUsage.output_tokens !== undefined &&
          typeof usageCallback === 'function'
        ) {
          usageCallback({
            ...collectedUsage,
            model: collectedUsage.model || modelId,
            accountId
          })
        }
      }

      const parseUsageFromSSELine = (rawLine) => {
        const line = rawLine.trim()
        if (!line || !line.startsWith('data:')) {
          return
        }
        const dataStr = line.slice(5).trim()
        if (!dataStr || dataStr === '[DONE]') {
          return
        }

        try {
          const data = JSON.parse(dataStr)
          if (data.type === 'message_start' && data.message?.usage) {
            collectedUsage.input_tokens = data.message.usage.input_tokens || 0
            collectedUsage.cache_creation_input_tokens =
              data.message.usage.cache_creation_input_tokens || 0
            collectedUsage.cache_read_input_tokens =
              data.message.usage.cache_read_input_tokens || 0
            if (data.message?.usage?.cache_creation) {
              collectedUsage.cache_creation = data.message.usage.cache_creation
            }
            if (data.message?.model) {
              collectedUsage.model = data.message.model
            }
          }
          if (data.type === 'message_delta' && data.usage) {
            collectedUsage.output_tokens = data.usage.output_tokens || 0
          }
        } catch {
          // ignore parse errors
        }
      }

      await new Promise((resolve) => {
        let settled = false
        const settle = () => {
          if (settled) {
            return
          }
          settled = true
          resolve()
        }

        response.data.on('data', (chunk) => {
          const chunkStr = chunk.toString('utf8')
          buffer += chunkStr

          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          if (lines.length > 0 && isStreamWritable(clientResponse)) {
            const linesToForward = `${lines.join('\n')}\n`
            if (streamTransformer) {
              const transformed = streamTransformer(linesToForward)
              if (transformed) {
                clientResponse.write(transformed)
              }
            } else {
              clientResponse.write(linesToForward)
            }
          }

          for (const line of lines) {
            parseUsageFromSSELine(line)
          }
        })

        response.data.on('end', () => {
          streamFinished = true
          cleanupClientListeners()

          if (buffer) {
            parseUsageFromSSELine(buffer)
            if (isStreamWritable(clientResponse)) {
              if (streamTransformer) {
                const transformed = streamTransformer(buffer)
                if (transformed) {
                  clientResponse.write(transformed)
                }
              } else {
                clientResponse.write(buffer)
              }
            }
          }

          emitUsageOnce()
          if (isStreamWritable(clientResponse)) {
            clientResponse.end()
          }
          logger.debug('🌊 GCP Vertex stream completed')
          settle()
        })

        response.data.on('error', (error) => {
          streamFinished = true
          cleanupClientListeners()

          if (abortController.signal.aborted || error.code === 'ERR_CANCELED') {
            logger.info('🔌 GCP Vertex stream aborted due to client disconnect')
          } else {
            logger.error('❌ GCP Vertex stream error:', error)
          }
          if (isStreamWritable(clientResponse)) {
            clientResponse.end()
          }
          settle()
        })
      })
    } finally {
      cleanupClientListeners()
      await releaseQueueLockSafe('finally')
    }
  }
}

module.exports = new GcpVertexRelayService()
