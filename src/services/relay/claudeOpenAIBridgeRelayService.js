const axios = require('axios')
const ProxyHelper = require('../../utils/proxyHelper')
const logger = require('../../utils/logger')
const config = require('../../../config/config')
const bridgeAccountService = require('../account/claudeOpenAIBridgeAccountService')
const apiKeyService = require('../apiKeyService')
const {
  convertClaudeRequestToOpenAI,
  convertOpenAIResponseToClaude,
  createStreamState,
  convertOpenAIStreamChunkToClaudeEvents
} = require('../claudeOpenAIBridgeConverter')
const { updateRateLimitCounters } = require('../../utils/rateLimitHelper')
const { createRequestDetailMeta } = require('../../utils/requestDetailHelper')

const ACCOUNT_TYPE = 'claude-openai-bridge'

class ClaudeOpenAIBridgeRelayService {
  constructor() {
    this.defaultTimeout = config.requestTimeout || 600000
  }

  async handleRequest(req, res, selection) {
    const account = selection?.account
    const mapping = selection?.mapping

    if (!account || !mapping) {
      return this._sendJsonError(res, 500, 'Claude OpenAI bridge selection is missing')
    }

    const stream = req.body?.stream === true
    const targetBody = convertClaudeRequestToOpenAI(req.body, mapping.targetModel)
    targetBody.stream = stream

    this._logHandoff(req, account, mapping, stream)

    const requestOptions = this._createRequestOptions(account, targetBody, stream)

    try {
      const response = await axios(requestOptions)

      if (response.status < 200 || response.status >= 300) {
        return this._handleUpstreamError(response, res, account)
      }

      if (stream) {
        return this._handleStreamResponse(response, req, res, account, mapping, targetBody)
      }

      return this._handleNormalResponse(response, req, res, account, mapping, targetBody)
    } catch (error) {
      logger.error('Claude OpenAI bridge relay error', this._compactError(error))
      await this._markAccountErrorIfAutoProtectionEnabled(
        account,
        error?.message || 'Claude OpenAI bridge request failed'
      )

      if (res.headersSent) {
        return res.end()
      }

      return this._sendJsonError(res, 502, 'Claude OpenAI bridge upstream request failed')
    }
  }

  _createRequestOptions(account, body, stream) {
    const requestOptions = {
      method: 'POST',
      url: account.endpointUrl,
      headers: {
        Authorization: `Bearer ${account.apiKey}`,
        'Content-Type': 'application/json'
      },
      data: body,
      timeout: this.defaultTimeout,
      responseType: stream ? 'stream' : 'json',
      validateStatus: () => true
    }

    if (account.proxy) {
      const proxyAgent = ProxyHelper.createProxyAgent(account.proxy)
      if (proxyAgent) {
        requestOptions.httpAgent = proxyAgent
        requestOptions.httpsAgent = proxyAgent
        requestOptions.proxy = false
        logger.info('Using proxy for Claude OpenAI bridge request', {
          accountId: account.id,
          proxy: ProxyHelper.getProxyDescription?.(account.proxy)
        })
      }
    }

    return requestOptions
  }

  async _handleNormalResponse(response, req, res, account, mapping, bridgeRequestBody) {
    const claudeResponse = convertOpenAIResponseToClaude(response.data, mapping.sourceModel)
    const usage = claudeResponse.usage || {}

    await this._recordUsage(req, account, mapping, usage, false, response.status, bridgeRequestBody)
    await bridgeAccountService.markAccountUsed(account.id)

    return res.status(response.status).json({
      ...claudeResponse,
      model: mapping.sourceModel
    })
  }

  async _handleStreamResponse(response, req, res, account, mapping, bridgeRequestBody) {
    if (!response.data || typeof response.data.on !== 'function') {
      await this._markAccountErrorIfAutoProtectionEnabled(
        account,
        'Claude OpenAI bridge upstream stream is invalid'
      )
      return this._sendJsonError(res, 502, 'Claude OpenAI bridge upstream stream is invalid')
    }

    this._setSSEHeaders(res)

    const state = createStreamState(mapping.sourceModel)
    let buffer = ''
    let wroteToClient = false
    let sawDone = false
    let recordPromise = null

    const recordUsageOnce = async () => {
      const usage = state.usage || {}
      const inputTokens = Number(usage.input_tokens || 0)
      const outputTokens = Number(usage.output_tokens || 0)

      if (recordPromise || inputTokens + outputTokens <= 0) {
        return recordPromise
      }

      recordPromise = this._recordUsage(
        req,
        account,
        mapping,
        usage,
        true,
        res.statusCode,
        bridgeRequestBody
      )
      return recordPromise
    }

    return new Promise((resolve) => {
      const finish = async () => {
        try {
          if (buffer.trim()) {
            this._processSSEBuffer(`${buffer}\n\n`, state, res, () => {
              wroteToClient = true
            })
            buffer = ''
          }

          await recordUsageOnce()

          if (!state.completed && !sawDone) {
            await this._markAccountErrorIfAutoProtectionEnabled(
              account,
              'Claude OpenAI bridge upstream stream ended early'
            )
            logger.warn('Claude OpenAI bridge stream ended before terminal event', {
              accountId: account.id,
              sourceModel: mapping.sourceModel,
              targetModel: mapping.targetModel
            })
            if (!wroteToClient && !res.headersSent) {
              this._sendJsonError(res, 502, 'Claude OpenAI bridge upstream stream ended early')
              return resolve()
            }
            if (wroteToClient) {
              this._writeSSEEvent(
                res,
                'error',
                this._createClaudeError(
                  502,
                  'Claude OpenAI bridge upstream stream ended early',
                  'api_error'
                )
              )
            }
          } else {
            await bridgeAccountService.markAccountUsed(account.id)
          }

          if (!res.writableEnded) {
            res.end()
          }
        } catch (error) {
          logger.error('Claude OpenAI bridge stream finalization error', this._compactError(error))
          if (!res.headersSent) {
            this._sendJsonError(res, 502, 'Claude OpenAI bridge stream failed')
          } else if (!res.writableEnded) {
            res.end()
          }
        }
        resolve()
      }

      response.data.on('data', (chunk) => {
        try {
          buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)

          const { buffer: nextBuffer, sawDone: chunkSawDone } = this._processSSEBuffer(
            buffer,
            state,
            res,
            () => {
              wroteToClient = true
            }
          )
          buffer = nextBuffer
          sawDone = sawDone || chunkSawDone
        } catch (error) {
          logger.error('Claude OpenAI bridge stream parse error', this._compactError(error))
        }
      })

      response.data.on('end', finish)
      response.data.on('error', async (error) => {
        logger.error('Claude OpenAI bridge upstream stream error', this._compactError(error))
        await this._markAccountErrorIfAutoProtectionEnabled(
          account,
          error?.message || 'Claude OpenAI bridge stream error'
        )

        if (!wroteToClient && !res.headersSent) {
          this._sendJsonError(res, 502, 'Claude OpenAI bridge upstream stream failed')
        } else if (!res.writableEnded) {
          res.end()
        }
        resolve()
      })
    })
  }

  _processSSEBuffer(buffer, state, res, markWritten) {
    let remaining = buffer
    let sawDone = false

    let delimiter = this._findSSEDelimiter(remaining)
    while (delimiter) {
      const { index: delimiterIndex, length: delimiterLength } = delimiter
      const rawEvent = remaining.slice(0, delimiterIndex)
      remaining = remaining.slice(delimiterIndex + delimiterLength)
      const dataLines = rawEvent
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())

      for (const data of dataLines) {
        if (!data) {
          continue
        }
        if (data === '[DONE]') {
          sawDone = true
          continue
        }

        let chunk
        try {
          chunk = JSON.parse(data)
        } catch (error) {
          logger.warn('Failed to parse Claude OpenAI bridge SSE chunk', {
            message: error.message
          })
          continue
        }

        const events = convertOpenAIStreamChunkToClaudeEvents(chunk, state)
        for (const event of events) {
          this._writeSSEEvent(res, event.type, event)
          markWritten()
        }
      }

      delimiter = this._findSSEDelimiter(remaining)
    }

    return { buffer: remaining, sawDone }
  }

  _findSSEDelimiter(buffer) {
    const lfIndex = buffer.indexOf('\n\n')
    const crlfIndex = buffer.indexOf('\r\n\r\n')

    if (lfIndex === -1 && crlfIndex === -1) {
      return null
    }

    if (crlfIndex !== -1 && (lfIndex === -1 || crlfIndex < lfIndex)) {
      return { index: crlfIndex, length: 4 }
    }

    return { index: lfIndex, length: 2 }
  }

  async _handleUpstreamError(response, res, account) {
    const errorData = await this._normalizeErrorData(response.data)
    const message = this._extractErrorMessage(errorData) || response.statusText || 'Upstream error'

    if (response.status === 429) {
      const retryAfterMinutes = this._retryAfterMinutes(response.headers)
      await bridgeAccountService.markAccountRateLimited(account.id, retryAfterMinutes)
      return res.status(429).json(this._createClaudeError(429, message, 'rate_limit_error'))
    }

    if (response.status === 401 || response.status === 403) {
      await bridgeAccountService.markAccountUnauthorized(account.id, message)
      return res
        .status(response.status)
        .json(this._createClaudeError(response.status, message, 'authentication_error'))
    }

    if (response.status >= 500) {
      await this._markAccountErrorIfAutoProtectionEnabled(account, message)
    }

    return res.status(response.status).json(this._createClaudeError(response.status, message))
  }

  async _normalizeErrorData(data) {
    if (!data || typeof data.on !== 'function') {
      return data
    }

    const chunks = []
    await new Promise((resolve) => {
      data.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
      data.on('end', resolve)
      data.on('error', resolve)
    })

    const raw = Buffer.concat(chunks).toString('utf8')
    try {
      return JSON.parse(raw)
    } catch {
      return { error: { message: raw || 'Upstream error' } }
    }
  }

  _setSSEHeaders(res) {
    if (res.headersSent) {
      return
    }
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
  }

  async _recordUsage(req, account, mapping, usage, stream, statusCode, bridgeRequestBody) {
    const inputTokens = Number(usage?.input_tokens || 0)
    const outputTokens = Number(usage?.output_tokens || 0)
    const model = mapping.sourceModel

    if (inputTokens + outputTokens <= 0) {
      return null
    }

    const requestMeta = createRequestDetailMeta(req, {
      requestBody: req?.body,
      stream,
      statusCode
    })
    requestMeta.bridgeTargetModel = mapping.targetModel
    requestMeta.bridgeRequestBody = bridgeRequestBody

    const costs = await apiKeyService.recordUsage(
      req.apiKey.id,
      inputTokens,
      outputTokens,
      0,
      0,
      model,
      account.id,
      ACCOUNT_TYPE,
      null,
      requestMeta
    )

    const costInfo = costs?.costs || costs || null
    if (req.rateLimitInfo) {
      await updateRateLimitCounters(
        req.rateLimitInfo,
        {
          inputTokens,
          outputTokens,
          totalTokens: inputTokens + outputTokens
        },
        model,
        req.apiKey.id,
        ACCOUNT_TYPE,
        costInfo
      )
    }

    const totalCost = Number(costInfo?.total ?? costInfo?.realCost ?? 0)
    if (Number(account.dailyQuota) > 0 && Number.isFinite(totalCost) && totalCost > 0) {
      await bridgeAccountService.updateUsageQuota(account.id, totalCost)
    }

    return costs
  }

  _retryAfterMinutes(headers = {}) {
    const retryAfter = headers['retry-after'] || headers['Retry-After']
    const retryAfterSeconds = Number(retryAfter)

    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      return Math.ceil(retryAfterSeconds / 60)
    }

    return null
  }

  _createClaudeError(status, message, type = 'api_error') {
    return {
      type: 'error',
      error: {
        type,
        message,
        code: status
      }
    }
  }

  _sendJsonError(res, status, message, type = 'api_error') {
    return res.status(status).json(this._createClaudeError(status, message, type))
  }

  _writeSSEEvent(res, type, event) {
    res.write(`event: ${type}\n`)
    res.write(`data: ${JSON.stringify(event)}\n\n`)
  }

  async _markAccountErrorIfAutoProtectionEnabled(account, message) {
    if (!account?.id) {
      return null
    }

    if (account.disableAutoProtection === true || account.disableAutoProtection === 'true') {
      logger.info('Claude OpenAI bridge auto-protection disabled, skipping account error mark', {
        accountId: account.id
      })
      return { success: true, skipped: true }
    }

    return bridgeAccountService.markAccountError(account.id, message).catch(() => {})
  }

  _extractErrorMessage(errorData) {
    if (!errorData) {
      return null
    }
    if (typeof errorData === 'string') {
      return errorData
    }
    return errorData.error?.message || errorData.message || null
  }

  _logHandoff(req, account, mapping, stream) {
    logger.info('Claude OpenAI bridge handoff', {
      sourceService: 'claude-messages',
      sourceModel: mapping.sourceModel,
      targetModel: mapping.targetModel,
      bridgeAccountId: account.id,
      bridgeAccountName: account.name,
      endpointUrl: account.endpointUrl,
      stream,
      claudeAccountId: req.apiKey?.claudeAccountId,
      claudeConsoleAccountId: req.apiKey?.claudeConsoleAccountId,
      claudeApiKeyId: req.apiKey?.claudeApiKeyId
    })
  }

  _compactError(error) {
    return {
      name: error?.name,
      code: error?.code,
      message: error?.message,
      status: error?.response?.status
    }
  }
}

module.exports = new ClaudeOpenAIBridgeRelayService()
