const { EventEmitter } = require('events')

jest.mock('axios', () => jest.fn())

jest.mock('../src/services/account/claudeOpenAIBridgeAccountService', () => ({
  markAccountUsed: jest.fn(),
  markAccountRateLimited: jest.fn(),
  markAccountUnauthorized: jest.fn(),
  markAccountError: jest.fn(),
  updateUsageQuota: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  recordUsage: jest.fn()
}))

jest.mock('../src/utils/rateLimitHelper', () => ({
  updateRateLimitCounters: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(),
  getProxyDescription: jest.fn(() => 'proxy')
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

jest.mock(
  '../config/config',
  () => ({
    requestTimeout: 1000
  }),
  { virtual: true }
)

jest.mock('../src/utils/requestDetailHelper', () => ({
  createRequestDetailMeta: jest.fn(() => ({ requestId: 'req-meta-1' }))
}))

const axios = require('axios')
const bridgeAccountService = require('../src/services/account/claudeOpenAIBridgeAccountService')
const apiKeyService = require('../src/services/apiKeyService')
const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')
const ProxyHelper = require('../src/utils/proxyHelper')
const relayService = require('../src/services/relay/claudeOpenAIBridgeRelayService')

function createReq(overrides = {}) {
  const req = new EventEmitter()
  Object.assign(req, {
    method: 'POST',
    originalUrl: '/api/v1/messages',
    headers: {
      'user-agent': 'test-client/1.0'
    },
    body: {
      model: 'claude-sonnet-4-bridge',
      max_tokens: 64,
      stream: false,
      messages: [{ role: 'user', content: 'Hello' }]
    },
    apiKey: {
      id: 'key-1',
      claudeAccountId: 'claude-binding-1',
      claudeConsoleAccountId: 'console-binding-1'
    },
    rateLimitInfo: {
      keyId: 'key-1',
      limit: 100
    }
  })

  Object.assign(req, overrides)
  return req
}

function createRes() {
  const res = new EventEmitter()
  res.headersSent = false
  res.statusCode = 200
  res.status = jest.fn().mockImplementation((code) => {
    res.statusCode = code
    return res
  })
  res.json = jest.fn().mockImplementation(() => {
    res.headersSent = true
    return res
  })
  res.setHeader = jest.fn()
  res.write = jest.fn().mockImplementation(() => {
    res.headersSent = true
    return true
  })
  res.end = jest.fn().mockImplementation(() => {
    res.headersSent = true
    return res
  })
  return res
}

function createSelection(overrides = {}) {
  return {
    account: {
      id: 'bridge-1',
      name: 'Bridge Account',
      endpointUrl: 'https://bridge.example.com/v1/chat/completions',
      apiKey: 'bridge-secret-key',
      dailyQuota: 10,
      ...overrides.account
    },
    mapping: {
      sourceModel: 'claude-sonnet-4-bridge',
      targetModel: 'gpt-4.1-mini',
      ...overrides.mapping
    }
  }
}

function createStream() {
  return new EventEmitter()
}

async function flushAsync() {
  await new Promise((resolve) => setImmediate(resolve))
}

describe('claudeOpenAIBridgeRelayService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    bridgeAccountService.markAccountUsed.mockResolvedValue({ success: true })
    bridgeAccountService.markAccountRateLimited.mockResolvedValue({ success: true })
    bridgeAccountService.markAccountUnauthorized.mockResolvedValue({ success: true })
    bridgeAccountService.markAccountError.mockResolvedValue({ success: true })
    bridgeAccountService.updateUsageQuota.mockResolvedValue({ success: true })
    apiKeyService.recordUsage.mockResolvedValue({
      costs: {
        total: 0.001,
        realCost: 0.001,
        ratedCost: 0.001
      }
    })
    updateRateLimitCounters.mockResolvedValue({ totalTokens: 18, totalCost: 0.001 })
    ProxyHelper.createProxyAgent.mockReturnValue(null)
  })

  it('posts converted non-stream requests and records Claude-model usage', async () => {
    axios.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        id: 'chatcmpl-1',
        choices: [
          {
            message: { role: 'assistant', content: 'Hello from OpenAI' },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 7
        }
      }
    })

    const req = createReq()
    const res = createRes()
    const selection = createSelection()

    await relayService.handleRequest(req, res, selection)

    expect(axios).toHaveBeenCalledTimes(1)
    expect(axios.mock.calls[0][0]).toMatchObject({
      method: 'POST',
      url: 'https://bridge.example.com/v1/chat/completions',
      responseType: 'json',
      headers: {
        Authorization: 'Bearer bridge-secret-key',
        'Content-Type': 'application/json'
      },
      data: {
        model: 'gpt-4.1-mini',
        stream: false,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Hello' }]
      }
    })
    expect(typeof axios.mock.calls[0][0].validateStatus).toBe('function')

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'chatcmpl-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-bridge',
        content: [{ type: 'text', text: 'Hello from OpenAI' }],
        usage: {
          input_tokens: 11,
          output_tokens: 7
        }
      })
    )
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-1',
      11,
      7,
      0,
      0,
      'claude-sonnet-4-bridge',
      'bridge-1',
      'claude-openai-bridge',
      null,
      { requestId: 'req-meta-1' }
    )
    expect(updateRateLimitCounters).toHaveBeenCalledWith(
      req.rateLimitInfo,
      { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
      'claude-sonnet-4-bridge',
      'key-1',
      'claude-openai-bridge',
      {
        total: 0.001,
        realCost: 0.001,
        ratedCost: 0.001
      }
    )
    expect(bridgeAccountService.markAccountUsed).toHaveBeenCalledWith('bridge-1')
    expect(bridgeAccountService.updateUsageQuota).toHaveBeenCalledWith('bridge-1', 0.001)
  })

  it('converts streamed OpenAI SSE, records late terminal usage once, and marks account used', async () => {
    const upstream = createStream()
    axios.mockResolvedValue({
      status: 200,
      headers: {},
      data: upstream
    })

    const req = createReq({
      body: {
        model: 'claude-sonnet-4-bridge',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'Stream' }]
      }
    })
    const res = createRes()
    const selection = createSelection()

    const requestPromise = relayService.handleRequest(req, res, selection)
    await flushAsync()

    upstream.emit(
      'data',
      Buffer.from(
        'data: {"id":"chatcmpl-stream","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n'
      )
    )
    upstream.emit(
      'data',
      Buffer.from(
        'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":13,"completion_tokens":5}}\n\n' +
          'data: [DONE]\n\n'
      )
    )
    upstream.emit('end')

    await requestPromise

    expect(axios.mock.calls[0][0]).toMatchObject({
      responseType: 'stream',
      data: expect.objectContaining({
        model: 'gpt-4.1-mini',
        stream: true
      })
    })
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream')
    expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-cache')
    expect(res.setHeader).toHaveBeenCalledWith('Connection', 'keep-alive')
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no')

    const output = res.write.mock.calls.map(([chunk]) => chunk).join('')
    expect(output).toContain('event: message_start')
    expect(output).toContain('"model":"claude-sonnet-4-bridge"')
    expect(output).toContain('event: content_block_delta')
    expect(output).toContain('"text":"Hel"')
    expect(output).toContain('"text":"lo"')
    expect(output).toContain('event: message_stop')

    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-1',
      13,
      5,
      0,
      0,
      'claude-sonnet-4-bridge',
      'bridge-1',
      'claude-openai-bridge',
      null,
      { requestId: 'req-meta-1' }
    )
    expect(bridgeAccountService.markAccountUsed).toHaveBeenCalledWith('bridge-1')
    expect(res.end).toHaveBeenCalled()
  })

  it('parses CRLF-delimited OpenAI SSE across chunks', async () => {
    const upstream = createStream()
    axios.mockResolvedValue({
      status: 200,
      headers: {},
      data: upstream
    })

    const req = createReq({
      body: {
        model: 'claude-sonnet-4-bridge',
        max_tokens: 64,
        stream: true,
        messages: [{ role: 'user', content: 'Stream' }]
      }
    })
    const res = createRes()
    const selection = createSelection()

    const requestPromise = relayService.handleRequest(req, res, selection)
    await flushAsync()

    upstream.emit(
      'data',
      Buffer.from(
        'data: {"id":"chatcmpl-crlf","choices":[{"delta":{"role":"assistant"},"finish_reason":null}]}\r\n\r'
      )
    )
    upstream.emit(
      'data',
      Buffer.from(
        '\ndata: {"choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\r\n\r\n' +
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\r\n\r'
      )
    )
    await flushAsync()

    let output = res.write.mock.calls.map(([chunk]) => chunk).join('')
    expect(output).toContain('event: message_start')
    expect(output).toContain('"text":"Hi"')

    upstream.emit(
      'data',
      Buffer.from(
        '\n' +
          'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":1}}\r\n\r\n' +
          'data: [DONE]\r\n\r\n'
      )
    )
    upstream.emit('end')

    await requestPromise

    output = res.write.mock.calls.map(([chunk]) => chunk).join('')
    expect(output).toContain('event: message_start')
    expect(output).toContain('"text":"Hi"')
    expect(output).toContain('event: message_stop')
    expect(apiKeyService.recordUsage).toHaveBeenCalledTimes(1)
    expect(apiKeyService.recordUsage).toHaveBeenCalledWith(
      'key-1',
      2,
      1,
      0,
      0,
      'claude-sonnet-4-bridge',
      'bridge-1',
      'claude-openai-bridge',
      null,
      { requestId: 'req-meta-1' }
    )
  })

  it('marks account rate limited and returns Claude-ish 429 for upstream 429', async () => {
    axios.mockResolvedValue({
      status: 429,
      headers: {
        'retry-after': '61'
      },
      data: {
        error: {
          message: 'Too many requests'
        }
      }
    })

    const req = createReq()
    const res = createRes()

    await relayService.handleRequest(req, res, createSelection())

    expect(bridgeAccountService.markAccountRateLimited).toHaveBeenCalledWith('bridge-1', 2)
    expect(res.status).toHaveBeenCalledWith(429)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          message: 'Too many requests',
          type: 'rate_limit_error'
        })
      })
    )
  })

  it('marks unauthorized accounts for upstream 401/403 and error accounts for upstream 5xx', async () => {
    axios
      .mockResolvedValueOnce({
        status: 401,
        headers: {},
        data: { error: { message: 'bad key' } }
      })
      .mockResolvedValueOnce({
        status: 503,
        headers: {},
        data: { error: { message: 'unavailable' } }
      })

    await relayService.handleRequest(createReq(), createRes(), createSelection())
    await relayService.handleRequest(createReq(), createRes(), createSelection())

    expect(bridgeAccountService.markAccountUnauthorized).toHaveBeenCalledWith('bridge-1', 'bad key')
    expect(bridgeAccountService.markAccountError).toHaveBeenCalledWith('bridge-1', 'unavailable')
  })

  it('adds proxy agents and disables axios proxy when account proxy is configured', async () => {
    const proxyAgent = { proxy: true }
    ProxyHelper.createProxyAgent.mockReturnValue(proxyAgent)
    axios.mockResolvedValue({
      status: 200,
      headers: {},
      data: {
        id: 'chatcmpl-proxy',
        choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1 }
      }
    })

    await relayService.handleRequest(
      createReq(),
      createRes(),
      createSelection({
        account: {
          proxy: { host: '127.0.0.1', port: 8080 }
        }
      })
    )

    expect(ProxyHelper.createProxyAgent).toHaveBeenCalledWith({ host: '127.0.0.1', port: 8080 })
    expect(axios.mock.calls[0][0]).toMatchObject({
      httpAgent: proxyAgent,
      httpsAgent: proxyAgent,
      proxy: false
    })
  })
})
