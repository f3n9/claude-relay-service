const { EventEmitter } = require('events')
const { PassThrough } = require('stream')

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/services/account/gcpVertexAccountService', () => ({
  getAccount: jest.fn(),
  getAccessToken: jest.fn(),
  markAccountRateLimited: jest.fn()
}))

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn()
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn()
}))

jest.mock('../src/services/userMessageQueueService', () => ({
  isUserMessageRequest: jest.fn(),
  acquireQueueLock: jest.fn(),
  releaseQueueLock: jest.fn()
}))

jest.mock('../src/utils/headerFilter', () => ({
  filterForClaude: jest.fn((headers) => headers || {})
}))

jest.mock('../src/utils/streamHelper', () => ({
  isStreamWritable: jest.fn(() => true)
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}))

const axios = require('axios')
const gcpVertexAccountService = require('../src/services/account/gcpVertexAccountService')
const userMessageQueueService = require('../src/services/userMessageQueueService')
const gcpVertexRelayService = require('../src/services/relay/gcpVertexRelayService')
const logger = require('../src/utils/logger')

describe('gcpVertexRelayService', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    userMessageQueueService.isUserMessageRequest.mockReturnValue(false)
    userMessageQueueService.releaseQueueLock.mockResolvedValue(undefined)

    gcpVertexAccountService.getAccount.mockResolvedValue({
      id: 'vertex-account-1',
      name: 'vertex-account-1',
      projectId: 'project-1',
      location: 'global',
      defaultModel: 'claude-opus-4-1',
      anthropicVersion: 'vertex-2023-10-16'
    })
    gcpVertexAccountService.getAccessToken.mockResolvedValue('vertex-token')
    gcpVertexAccountService.markAccountRateLimited.mockResolvedValue(undefined)
  })

  const createMockResponse = (initialHeaders = {}) => {
    const response = new EventEmitter()
    response.headers = { ...initialHeaders }
    response.statusCode = 200
    response.writableEnded = false
    response.destroyed = false
    response.socket = { destroyed: false }
    response.setHeader = jest.fn((key, value) => {
      response.headers[key] = value
    })
    response.getHeader = jest.fn((key) => response.headers[key])
    response.status = jest.fn((code) => {
      response.statusCode = code
      return response
    })
    response.write = jest.fn()
    response.end = jest.fn(() => {
      response.writableEnded = true
    })
    return response
  }

  it('preserves existing Connection header for Vertex streaming responses', async () => {
    const upstreamStream = new PassThrough()
    axios.post.mockImplementation(async () => {
      setImmediate(() => {
        upstreamStream.write('data: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n')
        upstreamStream.write('data: {"type":"message_delta","usage":{"output_tokens":2}}\n\n')
        upstreamStream.end()
      })
      return {
        status: 200,
        headers: {},
        data: upstreamStream
      }
    })

    const clientResponse = createMockResponse({ Connection: 'close' })

    await gcpVertexRelayService.relayStreamRequestWithUsageCapture(
      { model: 'claude-opus-4-1', stream: true },
      { id: 'key-1', name: 'key-1' },
      clientResponse,
      {},
      null,
      'vertex-account-1'
    )

    expect(clientResponse.headers.Connection).toBe('close')
    expect(clientResponse.setHeader).not.toHaveBeenCalledWith('Connection', 'keep-alive')
  })

  it('drops anthropic-beta header for Vertex requests', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: { ok: true }
    })

    await gcpVertexRelayService.relayRequest(
      { model: 'claude-opus-4-1' },
      { id: 'key-1', name: 'key-1' },
      null,
      createMockResponse(),
      {
        'anthropic-beta': 'test-beta-feature',
        'x-stainless-lang': 'js'
      },
      'vertex-account-1'
    )

    const axiosConfig = axios.post.mock.calls[0][2]
    expect(axiosConfig.headers['anthropic-beta']).toBeUndefined()
    expect(axiosConfig.headers['x-stainless-lang']).toBe('js')
    expect(axiosConfig.headers.Authorization).toBe('Bearer vertex-token')
    expect(axiosConfig.headers['Content-Type']).toBe('application/json')
  })

  it('drops context_management from Vertex request payload', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: { ok: true }
    })

    await gcpVertexRelayService.relayRequest(
      {
        model: 'claude-opus-4-1',
        messages: [{ role: 'user', content: 'hello' }],
        context_management: {
          type: 'ephemeral'
        }
      },
      { id: 'key-1', name: 'key-1' },
      null,
      createMockResponse(),
      {},
      'vertex-account-1'
    )

    const payload = axios.post.mock.calls[0][1]
    expect(payload.context_management).toBeUndefined()
    expect(payload.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('prefers request model over account default for non-stream requests', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: { ok: true }
    })

    await gcpVertexRelayService.relayRequest(
      { model: 'claude-haiku-3' },
      { id: 'key-1', name: 'key-1' },
      null,
      createMockResponse(),
      {},
      'vertex-account-1'
    )

    const endpoint = axios.post.mock.calls[0][0]
    expect(endpoint).toContain('/models/claude-haiku-3:rawPredict')
  })

  it('uses correct Vertex model id for claude-opus-4-6', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: { ok: true }
    })

    await gcpVertexRelayService.relayRequest(
      { model: 'claude-opus-4-6' },
      { id: 'key-1', name: 'key-1' },
      null,
      createMockResponse(),
      {},
      'vertex-account-1'
    )

    const endpoint = axios.post.mock.calls[0][0]
    expect(endpoint).toContain('/models/claude-opus-4-6:rawPredict')
  })

  it('uses correct Vertex model id for claude-sonnet-4-6', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: { ok: true }
    })

    await gcpVertexRelayService.relayRequest(
      { model: 'claude-sonnet-4-6' },
      { id: 'key-1', name: 'key-1' },
      null,
      createMockResponse(),
      {},
      'vertex-account-1'
    )

    const endpoint = axios.post.mock.calls[0][0]
    expect(endpoint).toContain('/models/claude-sonnet-4-6:rawPredict')
  })

  it('strips [1m] suffix from Vertex model ids', async () => {
    axios.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: { ok: true }
    })

    await gcpVertexRelayService.relayRequest(
      { model: 'claude-opus-4-6[1m]' },
      { id: 'key-1', name: 'key-1' },
      null,
      createMockResponse(),
      {},
      'vertex-account-1'
    )

    const endpoint = axios.post.mock.calls[0][0]
    expect(endpoint).toContain('/models/claude-opus-4-6:rawPredict')
    expect(endpoint).not.toContain('%5B1m%5D')
  })

  it('prefers request model over account default for stream requests', async () => {
    const upstreamStream = new PassThrough()
    axios.post.mockImplementation(async () => {
      setImmediate(() => {
        upstreamStream.end()
      })
      return {
        status: 200,
        headers: {},
        data: upstreamStream
      }
    })

    await gcpVertexRelayService.relayStreamRequestWithUsageCapture(
      { model: 'claude-haiku-3', stream: true },
      { id: 'key-1', name: 'key-1' },
      createMockResponse(),
      {},
      null,
      'vertex-account-1'
    )

    const endpoint = axios.post.mock.calls[0][0]
    expect(endpoint).toContain('/models/claude-haiku-3:streamRawPredict')
  })

  it('emits usage callback once for stream with multiple message_delta events', async () => {
    const upstreamStream = new PassThrough()
    axios.post.mockImplementation(async () => {
      setImmediate(() => {
        upstreamStream.write(
          'data: {"type":"message_start","message":{"usage":{"input_tokens":3,"cache_creation_input_tokens":1,"cache_read_input_tokens":2}}}\n\n'
        )
        upstreamStream.write('data: {"type":"message_delta","usage":{"output_tokens":4}}\n\n')
        upstreamStream.write('data: {"type":"message_delta","usage":{"output_tokens":9}}\n\n')
        upstreamStream.end()
      })
      return {
        status: 200,
        headers: {},
        data: upstreamStream
      }
    })

    const clientResponse = createMockResponse()
    const usageCallback = jest.fn()

    await gcpVertexRelayService.relayStreamRequestWithUsageCapture(
      { model: 'claude-opus-4-1', stream: true },
      { id: 'key-1', name: 'key-1' },
      clientResponse,
      {},
      usageCallback,
      'vertex-account-1'
    )

    expect(usageCallback).toHaveBeenCalledTimes(1)
    expect(usageCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        input_tokens: 3,
        cache_creation_input_tokens: 1,
        cache_read_input_tokens: 2,
        output_tokens: 9,
        accountId: 'vertex-account-1'
      })
    )
  })

  it('emits partial usage callback when stream closes after message_start', async () => {
    const upstreamStream = new EventEmitter()
    upstreamStream.destroy = jest.fn()

    axios.post.mockImplementation(async () => {
      setImmediate(() => {
        upstreamStream.emit(
          'data',
          Buffer.from(
            'data: {"type":"message_start","message":{"usage":{"input_tokens":12,"cache_creation_input_tokens":2,"cache_read_input_tokens":1}}}\n\n'
          )
        )
        upstreamStream.emit('close')
      })
      return {
        status: 200,
        headers: {},
        data: upstreamStream
      }
    })

    const usageCallback = jest.fn()
    await gcpVertexRelayService.relayStreamRequestWithUsageCapture(
      { model: 'claude-opus-4-1', stream: true },
      { id: 'key-1', name: 'key-1' },
      createMockResponse(),
      {},
      usageCallback,
      'vertex-account-1'
    )

    expect(usageCallback).toHaveBeenCalledTimes(1)
    expect(usageCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        input_tokens: 12,
        cache_creation_input_tokens: 2,
        cache_read_input_tokens: 1,
        output_tokens: 0,
        usage_capture_state: 'partial',
        accountId: 'vertex-account-1'
      })
    )
  })

  it('emits usage callback at most once when stream errors then closes', async () => {
    const upstreamStream = new EventEmitter()
    upstreamStream.destroy = jest.fn()

    axios.post.mockImplementation(async () => {
      setImmediate(() => {
        upstreamStream.emit(
          'data',
          Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n')
        )
        upstreamStream.emit(
          'data',
          Buffer.from('data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n')
        )
        upstreamStream.emit('error', new Error('mock upstream error'))
        upstreamStream.emit('close')
      })
      return {
        status: 200,
        headers: {},
        data: upstreamStream
      }
    })

    const usageCallback = jest.fn()
    await gcpVertexRelayService.relayStreamRequestWithUsageCapture(
      { model: 'claude-opus-4-1', stream: true },
      { id: 'key-1', name: 'key-1' },
      createMockResponse(),
      {},
      usageCallback,
      'vertex-account-1'
    )

    expect(usageCallback).toHaveBeenCalledTimes(1)
    expect(usageCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        input_tokens: 5,
        output_tokens: 7,
        usage_capture_state: 'complete',
        accountId: 'vertex-account-1'
      })
    )
  })

  it('captures usage from message_start.delta payloads before stream closes', async () => {
    const upstreamStream = new EventEmitter()
    upstreamStream.destroy = jest.fn()

    axios.post.mockImplementation(async () => {
      setImmediate(() => {
        upstreamStream.emit(
          'data',
          Buffer.from(
            'data: {"type":"message_start","message":{"model":"claude-opus-4-1"}}\n\ndata: {"type":"message_start_delta","usage":{"input_tokens":21,"cache_creation_input_tokens":3,"cache_read_input_tokens":2}}\n\n'
          )
        )
        upstreamStream.emit(
          'data',
          Buffer.from('data: {"type":"message_delta","usage":{"output_tokens":8}}\n\n')
        )
        upstreamStream.emit('close')
      })
      return {
        status: 200,
        headers: {},
        data: upstreamStream
      }
    })

    const usageCallback = jest.fn()
    await gcpVertexRelayService.relayStreamRequestWithUsageCapture(
      { model: 'claude-opus-4-1', stream: true },
      { id: 'key-1', name: 'key-1' },
      createMockResponse(),
      {},
      usageCallback,
      'vertex-account-1'
    )

    expect(usageCallback).toHaveBeenCalledTimes(1)
    expect(usageCallback).toHaveBeenCalledWith(
      expect.objectContaining({
        input_tokens: 21,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 2,
        output_tokens: 8,
        usage_capture_state: 'complete',
        model: 'claude-opus-4-1',
        accountId: 'vertex-account-1'
      })
    )
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Parsed Vertex stream usage from message_start_delta')
    )
  })

  it('logs missing stream usage when stream closes without parsable usage', async () => {
    const upstreamStream = new EventEmitter()
    upstreamStream.destroy = jest.fn()

    axios.post.mockImplementation(async () => {
      setImmediate(() => {
        upstreamStream.emit('data', Buffer.from('data: {"type":"ping"}\n\n'))
        upstreamStream.emit('close')
      })
      return {
        status: 200,
        headers: {},
        data: upstreamStream
      }
    })

    const usageCallback = jest.fn()
    await gcpVertexRelayService.relayStreamRequestWithUsageCapture(
      { model: 'claude-opus-4-1', stream: true },
      { id: 'key-1', name: 'key-1' },
      createMockResponse(),
      {},
      usageCallback,
      'vertex-account-1'
    )

    expect(usageCallback).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('No Vertex stream usage captured')
    )
  })

  it('aborts non-stream upstream call when client disconnects', async () => {
    const clientRequest = new EventEmitter()
    const clientResponse = createMockResponse()
    let capturedSignal

    axios.post.mockImplementation((endpoint, payload, axiosConfig) => {
      if (!axiosConfig.signal) {
        return Promise.reject(new Error('missing abort signal'))
      }

      capturedSignal = axiosConfig.signal
      return new Promise((resolve, reject) => {
        axiosConfig.signal.addEventListener('abort', () => {
          const abortError = new Error('Request canceled')
          abortError.code = 'ERR_CANCELED'
          abortError.name = 'CanceledError'
          reject(abortError)
        })
      })
    })

    const relayPromise = gcpVertexRelayService.relayRequest(
      { model: 'claude-opus-4-1' },
      { id: 'key-1', name: 'key-1' },
      clientRequest,
      clientResponse,
      {},
      'vertex-account-1'
    )

    await new Promise((resolve) => setImmediate(resolve))
    clientRequest.emit('close')

    await expect(relayPromise).rejects.toThrow('Client disconnected')
    expect(capturedSignal).toBeDefined()
    expect(capturedSignal.aborted).toBe(true)
  })

  it('settles stream relay when upstream closes after client disconnect', async () => {
    const upstreamStream = new EventEmitter()
    upstreamStream.destroy = jest.fn(() => {
      setImmediate(() => {
        upstreamStream.emit('close')
      })
    })

    axios.post.mockResolvedValue({
      status: 200,
      headers: {},
      data: upstreamStream
    })

    const clientResponse = createMockResponse()
    const relayPromise = gcpVertexRelayService.relayStreamRequestWithUsageCapture(
      { model: 'claude-opus-4-1', stream: true },
      { id: 'key-1', name: 'key-1' },
      clientResponse,
      {},
      null,
      'vertex-account-1'
    )

    await new Promise((resolve) => setImmediate(resolve))
    clientResponse.emit('close')

    const outcome = await Promise.race([
      relayPromise.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 200))
    ])

    expect(upstreamStream.destroy).toHaveBeenCalled()
    expect(outcome).toBe('resolved')
  })

  it('settles error-stream branch when upstream closes after client disconnect', async () => {
    const upstreamStream = new EventEmitter()
    upstreamStream.destroy = jest.fn(() => {
      setImmediate(() => {
        upstreamStream.emit('close')
      })
    })

    axios.post.mockResolvedValue({
      status: 500,
      headers: {},
      data: upstreamStream
    })

    const clientResponse = createMockResponse()
    const relayPromise = gcpVertexRelayService.relayStreamRequestWithUsageCapture(
      { model: 'claude-opus-4-1', stream: true },
      { id: 'key-1', name: 'key-1' },
      clientResponse,
      {},
      null,
      'vertex-account-1'
    )

    await new Promise((resolve) => setImmediate(resolve))
    clientResponse.emit('close')

    const outcome = await Promise.race([
      relayPromise.then(() => 'resolved'),
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 200))
    ])

    expect(upstreamStream.destroy).toHaveBeenCalled()
    expect(outcome).toBe('resolved')
  })
})
