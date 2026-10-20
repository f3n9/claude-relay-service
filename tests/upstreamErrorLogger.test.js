const { PassThrough } = require('stream')
const { EventEmitter } = require('events')
const zlib = require('zlib')

jest.mock('../src/utils/logger', () => ({ error: jest.fn(), info: jest.fn() }))

const logger = require('../src/utils/logger')
const {
  runWithUpstreamRequestContext,
  createLoggedAxios,
  observeUpstreamResponse,
  logUpstreamError,
  createLoggedHttpsRequest,
  installGeminiUpstreamLogging,
  bedrockLoggingMiddleware,
  observeBedrockEventStream
} = require('../src/utils/upstreamErrorLogger')

const request = () => ({
  requestId: 'request-1',
  apiKey: { id: 'key-1', name: '客户端测试 Key' },
  originalUrl: '/v1/chat/completions',
  body: { model: 'client-model', messages: [{ role: 'user', content: '完整请求 😀' }] }
})

const record = () =>
  logger.error.mock.calls.find(([, data]) => data?.type === 'upstream_error')?.[1]

describe('upstream error logging', () => {
  beforeEach(() => jest.clearAllMocks())

  it('records a local request cancellation as compact info instead of an upstream failure', async () => {
    const controller = new AbortController()
    const error = Object.assign(new Error('canceled'), {
      code: 'ERR_CANCELED',
      name: 'CanceledError'
    })
    const client = createLoggedAxios(async () => {
      controller.abort('client_disconnected')
      throw error
    }, 'openaiResponses')
    await expect(
      runWithUpstreamRequestContext(request(), () =>
        client({
          data: request().body,
          signal: controller.signal
        })
      )
    ).rejects.toBe(error)
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      'Upstream model request canceled',
      expect.objectContaining({
        type: 'upstream_canceled',
        apiKeyName: '客户端测试 Key',
        modelId: 'client-model',
        cancellationReason: 'client_disconnected',
        errorCode: 'ERR_CANCELED'
      })
    )
    expect(logger.info.mock.calls[0][1].requestBody).toBeUndefined()
  })

  it('does not report successful model output followed by local stream cancellation as an error', async () => {
    const controller = new AbortController()
    const stream = new PassThrough()
    await createLoggedAxios(
      jest.fn().mockResolvedValue({ status: 200, headers: {}, data: stream }),
      'test'
    )({
      data: {},
      signal: controller.signal
    })
    stream.write('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')
    controller.abort('client_disconnected')
    stream.emit('error', Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))
    stream.emit('close')
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledTimes(1)
  })

  it('keeps genuine upstream failures when a locally aborted stream already has HTTP 429 or a model error', () => {
    for (const response of [
      { status: 429, headers: {}, data: new PassThrough() },
      { status: 200, headers: {}, data: new PassThrough() }
    ]) {
      const controller = new AbortController()
      observeUpstreamResponse(response, { provider: 'test', signal: controller.signal })
      response.data.write('data: {"error":{"message":"rate limit"}}\n\n')
      controller.abort('client_disconnected')
      response.data.emit('error', Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))
    }
    expect(logger.error).toHaveBeenCalledTimes(2)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('keeps cancellations without an aborted local signal and local deadline failures as errors', async () => {
    const error = Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' })
    await expect(
      createLoggedAxios(jest.fn().mockRejectedValue(error), 'test')({ data: {} })
    ).rejects.toBe(error)
    const controller = new AbortController()
    controller.abort(Object.assign(new Error('deadline exceeded'), { name: 'TimeoutError' }))
    await expect(
      createLoggedAxios(
        jest.fn().mockRejectedValue({ ...error, code: 'ERR_CANCELED' }),
        'test'
      )({
        data: {},
        signal: controller.signal
      })
    ).rejects.toMatchObject({ code: 'ERR_CANCELED' })
    expect(logger.error).toHaveBeenCalledTimes(2)
    expect(logger.info).not.toHaveBeenCalled()
  })

  it('records original client context and complete upstream details without changing a response', async () => {
    const req = request()
    const response = {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'x-request-id': 'upstream-1', 'set-cookie': ['session=test-cookie'] },
      data: { error: { message: '长错误😀'.repeat(20000) } }
    }
    const transport = jest.fn().mockResolvedValue(response)
    const client = createLoggedAxios(transport, 'test-provider')
    await runWithUpstreamRequestContext(req, async () => {
      req.body.messages[0].content = '转换后的内容'
      const result = await client({
        url: 'https://upstream.example/models?key=test-upstream-secret',
        data: { model: 'upstream-model' }
      })
      expect(result).toBe(response)
    })

    expect(record()).toMatchObject({
      requestId: 'request-1',
      apiKeyName: '客户端测试 Key',
      modelId: 'client-model',
      requestBody: request().body,
      upstreamRequestBody: { model: 'upstream-model' },
      upstreamStatus: 503,
      upstreamStatusText: 'Service Unavailable',
      upstreamResponseHeaders: { 'x-request-id': 'upstream-1', 'set-cookie': '[REDACTED_SECRET]' },
      upstreamResponseBody: response.data
    })
    expect(record().upstreamUrl).not.toContain('test-upstream-secret')
  })

  it.each([200, 201, 204, 206, 299])('does not log successful HTTP %s', async (status) => {
    const response = { status, headers: {}, data: { ok: true } }
    await createLoggedAxios(jest.fn().mockResolvedValue(response), 'test')({ data: {} })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each([301, 400, 401, 429, 500])('logs non-2xx HTTP %s', async (status) => {
    await createLoggedAxios(
      jest.fn().mockResolvedValue({ status, headers: {}, data: 'upstream body' }),
      'test'
    )({ data: { model: 'm' } })
    expect(record().upstreamStatus).toBe(status)
  })

  it('preserves rejected Axios errors and logs response headers and body', async () => {
    const error = Object.assign(new Error('Request failed'), {
      code: 'ERR_BAD_RESPONSE',
      response: { status: 502, headers: { server: 'test' }, data: 'bad gateway' }
    })
    const transport = { post: jest.fn().mockRejectedValue(error) }
    await expect(
      createLoggedAxios(transport, 'vertex').post('https://upstream.example', { model: 'm' }, {})
    ).rejects.toBe(error)
    expect(record()).toMatchObject({
      upstreamStatus: 502,
      upstreamResponseHeaders: { server: 'test' },
      upstreamResponseBody: 'bad gateway',
      errorCode: 'ERR_BAD_RESPONSE'
    })
  })

  it('logs network failures with explicitly unavailable response fields', async () => {
    const error = Object.assign(new Error('socket disconnected'), { code: 'ECONNRESET' })
    await expect(
      runWithUpstreamRequestContext(request(), () =>
        createLoggedAxios(jest.fn().mockRejectedValue(error), 'test')({ data: {} })
      )
    ).rejects.toBe(error)
    expect(record()).toMatchObject({
      apiKeyName: '客户端测试 Key',
      upstreamStatus: null,
      upstreamResponseHeaders: null,
      upstreamResponseBody: null,
      errorCode: 'ECONNRESET'
    })
  })

  it('logs an error envelope returned with HTTP 200', async () => {
    await createLoggedAxios(
      jest
        .fn()
        .mockResolvedValue({ status: 200, headers: {}, data: { error: { message: 'failed' } } }),
      'test'
    )({ data: {} })
    expect(record().upstreamResponseBody).toEqual({ error: { message: 'failed' } })
  })

  it('captures an entire chunked error stream and preserves bytes and backpressure', async () => {
    const stream = new PassThrough({ highWaterMark: 4 })
    const response = { status: 429, headers: { 'retry-after': '30' }, data: stream }
    const client = createLoggedAxios(jest.fn().mockResolvedValue(response), 'test')
    const result = await runWithUpstreamRequestContext(request(), () => client({ data: {} }))
    expect(result).toBe(response)
    expect(result.data).toBe(stream)
    const body = '错误 😀 '.repeat(10000)
    const received = []
    const consume = (async () => {
      for await (const chunk of stream) {
        received.push(chunk)
      }
    })()
    const bytes = Buffer.from(body)
    for (let index = 0; index < bytes.length; index += 31) {
      if (!stream.write(bytes.subarray(index, index + 31))) {
        await new Promise((resolve) => stream.once('drain', resolve))
      }
    }
    stream.end()
    await consume
    expect(Buffer.concat(received).toString()).toBe(body)
    expect(record().upstreamResponseBody).toBe(body)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('handles bytes already buffered before observing an Axios stream', async () => {
    const stream = new PassThrough()
    stream.write('first ')
    const response = { status: 500, headers: {}, data: stream }
    observeUpstreamResponse(response, { provider: 'test' })
    stream.end('last')
    for await (const _chunk of stream) {
      // Consume as a real relay does.
    }
    expect(record().upstreamResponseBody).toBe('first last')
  })

  it.each(['gzip', 'deflate', 'br'])('decodes native HTTP %s error bodies', (encoding) => {
    const body = JSON.stringify({ error: { message: '压缩后的错误 😀' } })
    const compress = { gzip: zlib.gzipSync, deflate: zlib.deflateSync, br: zlib.brotliCompressSync }
    const stream = new PassThrough()
    stream.statusCode = 500
    stream.headers = { 'content-encoding': encoding }
    observeUpstreamResponse(stream, { provider: 'claude', compressed: true })
    stream.end(compress[encoding](Buffer.from(body)))
    expect(record().upstreamResponseBody).toBe(body)
  })

  it('detects split SSE error events even with HTTP 200', () => {
    const stream = new PassThrough()
    observeUpstreamResponse(
      { status: 200, headers: { 'content-type': 'text/event-stream' }, data: stream },
      { provider: 'test' }
    )
    stream.write('data: {"choices":[]}\r\n\r\nevent: err')
    stream.write('or\r\ndata: {"error":{"message":"failed"}}\r\n\r\n')
    stream.end('data: [DONE]\n\n')
    expect(record().upstreamStatus).toBe(200)
    expect(record().upstreamResponseBody).toContain('data: [DONE]')
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('logs partial stream content when the upstream stream fails', () => {
    const stream = new PassThrough()
    observeUpstreamResponse({ status: 200, headers: {}, data: stream }, { provider: 'test' })
    stream.write('partial upstream content')
    stream.emit('error', Object.assign(new Error('stream reset'), { code: 'ECONNRESET' }))
    expect(record()).toMatchObject({
      upstreamStatus: 200,
      upstreamResponseBody: 'partial upstream content',
      responseBodyComplete: false,
      errorCode: 'ECONNRESET'
    })
  })

  it('keeps simultaneous client request contexts isolated', async () => {
    const client = createLoggedAxios(async (options) => {
      await new Promise((resolve) => setImmediate(resolve))
      return { status: 500, headers: {}, data: options.data }
    }, 'test')
    await Promise.all(
      ['a', 'b'].map((name) =>
        runWithUpstreamRequestContext(
          { ...request(), apiKey: { name }, body: { model: name } },
          () => client({ data: { model: name } })
        )
      )
    )
    const records = logger.error.mock.calls.map(([, data]) => data)
    expect(records.map((data) => [data.apiKeyName, data.modelId, data.requestBody.model])).toEqual([
      ['a', 'a', 'a'],
      ['b', 'b', 'b']
    ])
  })

  it('gets Gemini model IDs from URL routes and logs SDK error details', () => {
    runWithUpstreamRequestContext(
      {
        ...request(),
        body: { contents: [] },
        originalUrl: '/gemini/v1/models/gemini-2.5-pro:generateContent'
      },
      () => logUpstreamError({ provider: 'bedrock', error: new Error('SDK failure') })
    )
    expect(record().modelId).toBe('gemini-2.5-pro')
  })

  it('retains the original context when a router authenticates again after converting the body', () => {
    const req = request()
    runWithUpstreamRequestContext(req, () => {
      req.body = { model: 'converted-model' }
      runWithUpstreamRequestContext(req, () => logUpstreamError({ provider: 'test', status: 500 }))
    })
    expect(record().requestBody).toEqual(request().body)
  })

  it('logs a native HTTPS timeout once without changing the request object', () => {
    const upstream = new EventEmitter()
    const transport = { request: jest.fn(() => upstream) }
    const send = createLoggedHttpsRequest(transport, { provider: 'claude', requestBody: '{}' })
    expect(send({ hostname: 'upstream.example', path: '/v1/messages' }, jest.fn())).toBe(upstream)
    upstream.emit('timeout')
    upstream.emit('error', new Error('socket closed'))
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(record().errorCode).toBe('ETIMEDOUT')
  })

  it('observes Bedrock HTTP errors before SDK deserialization consumes the stream', async () => {
    const stream = new PassThrough()
    const result = {
      response: { statusCode: 403, headers: { 'x-amzn-requestid': 'aws-1' }, body: stream }
    }
    const middleware = bedrockLoggingMiddleware(jest.fn().mockResolvedValue(result))
    expect(
      await middleware({ request: { hostname: 'bedrock.example', path: '/model/m', body: '{}' } })
    ).toBe(result)
    stream.end('{"message":"Access denied"}')
    const chunks = []
    for await (const chunk of stream) {
      chunks.push(chunk)
    }
    expect(Buffer.concat(chunks).toString()).toBe('{"message":"Access denied"}')
    expect(record()).toMatchObject({
      provider: 'bedrock',
      upstreamStatus: 403,
      upstreamResponseHeaders: { 'x-amzn-requestid': 'aws-1' },
      upstreamResponseBody: '{"message":"Access denied"}'
    })
  })

  it('logs Bedrock exception events with headers while preserving event objects', async () => {
    const event = { modelStreamErrorException: { message: 'failed', originalStatusCode: 500 } }
    const response = {
      $metadata: { httpStatusCode: 200 },
      _upstreamResponseHeaders: { 'x-amzn-requestid': 'aws-2' },
      body: (async function* () {
        yield event
      })()
    }
    const received = []
    await runWithUpstreamRequestContext(request(), async () => {
      for await (const chunk of observeBedrockEventStream(response, { model: 'upstream-model' })) {
        received.push(chunk)
      }
    })
    expect(received[0]).toBe(event)
    expect(record()).toMatchObject({
      apiKeyName: '客户端测试 Key',
      upstreamResponseHeaders: { 'x-amzn-requestid': 'aws-2' },
      upstreamResponseBody: [event]
    })
  })

  it('logs Gemini Code Assist calls made through default Axios without changing account code', async () => {
    const axios = require('axios').create()
    const removeLogging = installGeminiUpstreamLogging(axios)
    const body = { model: 'upstream-model', request: { contents: [] } }
    try {
      const result = await runWithUpstreamRequestContext(request(), () =>
        axios.post('https://cloudcode-pa.googleapis.com/v1internal:generateContent', body, {
          adapter: async (config) => ({
            config,
            status: 503,
            headers: { 'x-request-id': 'code-assist' },
            data: '{"error":{"message":"failed"}}'
          })
        })
      )
      expect(result.status).toBe(503)
      expect(record()).toMatchObject({
        provider: 'gemini',
        apiKeyName: '客户端测试 Key',
        modelId: 'client-model',
        requestBody: request().body,
        upstreamRequestBody: body,
        upstreamStatus: 503,
        upstreamResponseHeaders: { 'x-request-id': 'code-assist' },
        upstreamResponseBody: { error: { message: 'failed' } }
      })
    } finally {
      removeLogging()
    }
  })

  it('does not observe OAuth requests or unrelated hosts through Gemini interceptors', async () => {
    const axios = require('axios').create()
    const removeLogging = installGeminiUpstreamLogging(axios)
    try {
      for (const url of [
        'https://oauth2.googleapis.com/token',
        'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist',
        'https://unrelated.example/v1internal:generateContent'
      ]) {
        await axios.post(url, 'test-only-body', {
          adapter: async (config) => ({ config, status: 500, headers: {}, data: 'failed' })
        })
      }
      expect(logger.error).not.toHaveBeenCalled()
    } finally {
      removeLogging()
    }
  })

  it('avoids duplicate Gemini error logs when a wrapped client also uses interceptors', async () => {
    const axios = require('axios').create()
    const removeLogging = installGeminiUpstreamLogging(axios)
    try {
      await createLoggedAxios(
        axios,
        'gemini'
      )({
        url: 'https://cloudcode-pa.googleapis.com/v1internal:countTokens',
        data: {},
        adapter: async (config) => ({ config, status: 500, headers: {}, data: 'failed' })
      })
      expect(logger.error).toHaveBeenCalledTimes(1)
    } finally {
      removeLogging()
    }
  })

  it('logs Gemini network failures once and preserves the original error', async () => {
    const axios = require('axios').create()
    const removeLogging = installGeminiUpstreamLogging(axios)
    const error = Object.assign(new Error('network failed'), { code: 'ECONNRESET' })
    try {
      await expect(
        createLoggedAxios(
          axios,
          'gemini'
        )({
          url: 'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent',
          data: {},
          adapter: async (config) => {
            error.config = config
            throw error
          }
        })
      ).rejects.toBe(error)
      expect(logger.error).toHaveBeenCalledTimes(1)
      expect(record().errorCode).toBe('ECONNRESET')
    } finally {
      removeLogging()
    }
  })

  it('captures Gemini streaming error bodies through interceptors after the request context exits', async () => {
    const axios = require('axios').create()
    const removeLogging = installGeminiUpstreamLogging(axios)
    const stream = new PassThrough()
    try {
      const response = await runWithUpstreamRequestContext(request(), () =>
        axios.post(
          'https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent',
          { model: 'm' },
          {
            responseType: 'stream',
            adapter: async (config) => ({
              config,
              status: 200,
              headers: { 'content-type': 'text/event-stream' },
              data: stream
            })
          }
        )
      )
      expect(response.data).toBe(stream)
      stream.end('event: error\ndata: {"error":{"message":"stream failed"}}\n\n')
      expect(record()).toMatchObject({
        apiKeyName: '客户端测试 Key',
        upstreamStatus: 200,
        upstreamResponseBody: 'event: error\ndata: {"error":{"message":"stream failed"}}\n\n'
      })
    } finally {
      removeLogging()
    }
  })
})
