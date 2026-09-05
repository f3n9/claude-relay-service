const { PassThrough } = require('stream')
const { EventEmitter } = require('events')

jest.mock('axios', () => ({ post: jest.fn() }))
jest.mock('../config/config', () => ({ requestTimeout: 1000 }))
jest.mock('../src/middleware/auth', () => ({ authenticateApiKey: (req, res, next) => next() }))
jest.mock('../src/services/scheduler/unifiedOpenAIScheduler', () => ({
  selectAccountForApiKey: jest.fn(),
  isAccountRateLimited: jest.fn(),
  removeAccountRateLimit: jest.fn(),
  markAccountRateLimited: jest.fn(),
  markAccountUnauthorized: jest.fn(),
  _deleteSessionMapping: jest.fn()
}))
jest.mock('../src/services/account/openaiAccountService', () => ({
  getAccount: jest.fn(),
  isTokenExpired: jest.fn(),
  decrypt: jest.fn()
}))
jest.mock('../src/services/account/openaiResponsesAccountService', () => ({
  getAccount: jest.fn(),
  updateAccountUsage: jest.fn(),
  updateUsageQuota: jest.fn()
}))
jest.mock('../src/services/relay/openaiResponsesRelayService', () => ({}))
jest.mock('../src/services/apiKeyService', () => ({
  hasPermission: jest.fn(),
  recordUsage: jest.fn()
}))
jest.mock('../src/models/redis', () => ({}))
jest.mock('../src/utils/proxyHelper', () => ({ createProxyAgent: jest.fn() }))
jest.mock('../src/utils/rateLimitHelper', () => ({ updateRateLimitCounters: jest.fn() }))
jest.mock('../src/utils/upstreamErrorHelper', () => ({ markTempUnavailable: jest.fn() }))
jest.mock('../src/services/requestBodyRuleService', () => ({}))
jest.mock('../src/routes/azureOpenaiRoutes', () => ({ handleEmbeddingsRequest: jest.fn() }))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

const axios = require('axios')
const scheduler = require('../src/services/scheduler/unifiedOpenAIScheduler')
const oauthAccounts = require('../src/services/account/openaiAccountService')
const apiAccounts = require('../src/services/account/openaiResponsesAccountService')
const apiKeys = require('../src/services/apiKeyService')
const proxyHelper = require('../src/utils/proxyHelper')
const upstreamErrorHelper = require('../src/utils/upstreamErrorHelper')
const router = require('../src/routes/openaiRoutes')
const handleImages = router.stack.find((layer) => layer.route?.path === '/images/generations').route
  .stack[1].handle

function request(body = {}) {
  return Object.assign(new EventEmitter(), {
    apiKey: { id: 'key-1', permissions: ['openai'], openaiAccountId: 'responses:api-1' },
    headers: {},
    body: { prompt: 'a cat', ...body },
    method: 'POST',
    path: '/v1/images/generations',
    originalUrl: '/openai/v1/images/generations'
  })
}

function response() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    headersSent: false,
    destroyed: false,
    writableEnded: false,
    chunks: [],
    setHeader: jest.fn(),
    flushHeaders() {
      this.headersSent = true
    },
    write(chunk) {
      this.headersSent = true
      this.chunks.push(chunk)
      return true
    },
    end() {
      this.writableEnded = true
    },
    status(code) {
      this.statusCode = code
      return this
    },
    json(body) {
      this.body = body
      this.headersSent = true
      this.writableEnded = true
      return this
    }
  })
}

const imageItem = (id = 'ig_1', result = 'FINAL') => ({
  type: 'image_generation_call',
  id,
  status: 'completed',
  result,
  size: '1024x1024',
  quality: 'high',
  output_format: 'png'
})
const completed = (output = [imageItem()]) => ({
  type: 'response.completed',
  response: {
    status: 'completed',
    model: 'gpt-5.4-mini',
    output,
    usage: { input_tokens: 10, output_tokens: 20 }
  }
})
const preview = (index) => ({
  type: 'response.image_generation_call.partial_image',
  item_id: 'ig_1',
  partial_image_index: index,
  partial_image_b64: `PREVIEW_${index}`
})

function streamResponse(events, { status = 200, crlf = false, split = false } = {}) {
  const stream = new PassThrough()
  const delimiter = crlf ? '\r\n' : '\n'
  const text = events
    .map((event) => `data: ${JSON.stringify(event)}${delimiter}${delimiter}`)
    .join('')
  if (split) {
    for (const byte of Buffer.from(text)) {
      stream.write(Buffer.from([byte]))
    }
    stream.end()
  } else {
    stream.end(text)
  }
  axios.post.mockResolvedValue({ status, headers: {}, data: stream })
  return stream
}

beforeEach(() => {
  jest.resetAllMocks()
  apiKeys.hasPermission.mockReturnValue(true)
  apiKeys.recordUsage.mockResolvedValue({ realCost: 0.1, ratedCost: 0.1 })
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'oauth-1',
    accountType: 'openai'
  })
  scheduler.isAccountRateLimited.mockResolvedValue(false)
  oauthAccounts.getAccount.mockResolvedValue({
    id: 'oauth-1',
    accessToken: 'encrypted',
    accountId: 'chatgpt-1'
  })
  oauthAccounts.decrypt.mockReturnValue('oauth-token')
  apiAccounts.getAccount.mockResolvedValue({
    id: 'api-1',
    apiKey: 'provider-secret',
    baseApi: 'https://api.openai.com/v1',
    dailyQuota: '10'
  })
})

test('returns final image with no previews and records usage once', async () => {
  streamResponse([completed()])
  const res = response()
  await handleImages(request(), res)
  expect(res.statusCode).toBe(200)
  expect(res.body.data).toEqual([{ b64_json: 'FINAL' }])
  expect(res.body.size).toBe('1024x1024')
  expect(apiKeys.recordUsage).toHaveBeenCalledTimes(1)
})

test('ignores preview indices and deduplicates final events across split CRLF chunks', async () => {
  streamResponse(
    [
      preview(0),
      preview(1),
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: imageItem()
      },
      completed()
    ],
    { crlf: true, split: true }
  )
  const res = response()
  await handleImages(request({ n: 1 }), res)
  expect(res.body.data).toEqual([{ b64_json: 'FINAL' }])
})

test('returns multiple final images in output order', async () => {
  streamResponse([completed([imageItem('ig_1', 'FIRST'), imageItem('ig_2', 'SECOND')])])
  const res = response()
  await handleImages(request({ n: 2 }), res)
  expect(res.body.data).toEqual([{ b64_json: 'FIRST' }, { b64_json: 'SECOND' }])
})

test.each([
  {
    type: 'response.failed',
    response: { error: { code: 'usage_limit_reached', message: 'quota', resets_in_seconds: 90 } }
  },
  { type: 'error', error: { type: 'usage_limit_reached', message: 'quota', resets_in_seconds: 90 } }
])('does not return previews on SSE quota errors: $type', async (event) => {
  streamResponse([preview(0), event])
  const res = response()
  await handleImages(request({ session_id: 'session' }), res)
  expect(res.statusCode).toBe(429)
  expect(scheduler.markAccountRateLimited).toHaveBeenCalledWith(
    'oauth-1',
    'openai',
    expect.any(String),
    90
  )
  expect(scheduler.removeAccountRateLimit).not.toHaveBeenCalled()
})

test.each([[preview(0)], [{ type: 'response.incomplete', response: { status: 'incomplete' } }]])(
  'rejects an incomplete generation',
  async (...events) => {
    streamResponse(events)
    const res = response()
    await handleImages(request(), res)
    expect(res.statusCode).toBe(502)
  }
)

test.each(['https://api.openai.com', 'https://api.openai.com/v1/'])(
  'API account calls native images endpoint for %s',
  async (baseApi) => {
    scheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'api-1',
      accountType: 'openai-responses'
    })
    apiAccounts.getAccount.mockResolvedValue({
      id: 'api-1',
      apiKey: 'provider-secret',
      baseApi,
      apiVersion: '2025-04-01-preview'
    })
    const data = {
      created: 123,
      data: [{ b64_json: 'API_IMAGE' }],
      usage: { input_tokens: 10, output_tokens: 100 }
    }
    axios.post.mockResolvedValue({ status: 200, data })
    const req = request({ quality: 'high', n: 2, output_format: 'webp', output_compression: 80 })
    const res = response()
    await handleImages(req, res)
    expect(res.body).toEqual(data)
    expect(axios.post).toHaveBeenCalledWith(
      'https://api.openai.com/v1/images/generations',
      expect.objectContaining({
        model: 'gpt-image-2',
        prompt: 'a cat',
        n: 2,
        quality: 'high',
        output_format: 'webp',
        output_compression: 80
      }),
      expect.objectContaining({
        headers: expect.objectContaining({ authorization: 'Bearer provider-secret' }),
        signal: expect.anything()
      })
    )
    expect(scheduler.selectAccountForApiKey.mock.calls[0][0]).toBe(req.apiKey)
    expect(apiKeys.recordUsage.mock.calls[0].slice(5, 8)).toEqual([
      'gpt-image-2',
      'api-1',
      'openai-responses'
    ])
    expect(apiAccounts.updateAccountUsage).toHaveBeenCalledWith('api-1', 110)
  }
)

test('preserves API provider proxy, URL prefix and api-version', async () => {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'api-1',
    accountType: 'openai-responses'
  })
  apiAccounts.getAccount.mockResolvedValue({
    id: 'api-1',
    apiKey: 'provider-secret',
    baseApi: 'https://provider.example/proxy/v1/',
    apiVersion: 'custom',
    proxy: { host: 'proxy' }
  })
  const agent = {}
  proxyHelper.createProxyAgent.mockReturnValue(agent)
  axios.post.mockResolvedValue({ status: 200, data: { data: [{ b64_json: 'IMAGE' }] } })
  await handleImages(request(), response())
  expect(axios.post.mock.calls[0][0]).toBe(
    'https://provider.example/proxy/v1/images/generations?api-version=custom'
  )
  expect(axios.post.mock.calls[0][2]).toMatchObject({
    httpAgent: agent,
    httpsAgent: agent,
    proxy: false
  })
})

test.each([401, 429])('marks API account HTTP %s using the correct provider', async (status) => {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'api-1',
    accountType: 'openai-responses'
  })
  axios.post.mockResolvedValue({
    status,
    data: { error: { message: 'denied', resets_in_seconds: 60 } }
  })
  const res = response()
  await handleImages(request(), res)
  expect(res.statusCode).toBe(status)
  if (status === 429) {
    expect(scheduler.markAccountRateLimited).toHaveBeenCalledWith(
      'api-1',
      'openai-responses',
      null,
      60
    )
  } else {
    expect(upstreamErrorHelper.markTempUnavailable).toHaveBeenCalledWith(
      'api-1',
      'openai-responses',
      401
    )
  }
  expect(scheduler.markAccountUnauthorized).not.toHaveBeenCalled()
})

test('aborts a pending upstream request when response closes', async () => {
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  axios.post.mockImplementation(
    (url, body, options) =>
      new Promise((resolve, reject) => {
        options.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' }))
        )
        started()
      })
  )
  const res = response()
  const pending = handleImages(request(), res)
  await ready
  res.destroyed = true
  res.emit('close')
  expect(axios.post.mock.calls[0][2].signal?.aborted).toBe(true)
  await pending
  expect(res.headersSent).toBe(false)
  expect(res.listenerCount('close')).toBe(0)
})

test('destroys active upstream on response close, but not on completed request body', async () => {
  const stream = new PassThrough()
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  axios.post.mockImplementation(async () => {
    started()
    return { status: 200, data: stream }
  })
  const req = request()
  const res = response()
  const pending = handleImages(req, res)
  await ready
  await new Promise(setImmediate)
  req.emit('close')
  expect(stream.destroyed).toBe(false)
  res.destroyed = true
  res.emit('close')
  expect(stream.destroyed).toBe(true)
  await pending
  expect(res.headersSent).toBe(false)
})

test('rejects missing permissions before scheduling', async () => {
  apiKeys.hasPermission.mockReturnValue(false)
  const res = response()
  await handleImages(request(), res)
  expect(res.statusCode).toBe(403)
  expect(scheduler.selectAccountForApiKey).not.toHaveBeenCalled()
})

test('marks OAuth HTTP errors and preserves the original status', async () => {
  const stream = new PassThrough()
  stream.end(JSON.stringify({ error: { message: 'expired token' } }))
  axios.post.mockResolvedValue({ status: 401, data: stream })
  const res = response()
  await handleImages(request(), res)
  expect(res.statusCode).toBe(401)
  expect(scheduler.markAccountUnauthorized).toHaveBeenCalledWith(
    'oauth-1',
    'openai',
    null,
    'Authentication failed'
  )
  expect(stream.destroyed).toBe(true)
})

test('clears a rate limit only after final generation succeeds', async () => {
  scheduler.isAccountRateLimited.mockResolvedValue(true)
  streamResponse([completed()])
  await handleImages(request(), response())
  expect(scheduler.removeAccountRateLimit).toHaveBeenCalledWith('oauth-1', 'openai')
})

test('recognizes top-level SSE error codes', async () => {
  streamResponse([{ type: 'error', code: 'rate_limit_exceeded', message: 'quota' }])
  const res = response()
  await handleImages(request(), res)
  expect(res.statusCode).toBe(429)
  expect(scheduler.markAccountRateLimited).toHaveBeenCalledWith('oauth-1', 'openai', null, null)
})

test('preserves HTTP 429 when its error response stream is broken', async () => {
  const stream = new PassThrough()
  axios.post.mockResolvedValue({ status: 429, data: stream })
  const res = response()
  const pending = handleImages(request(), res)
  await new Promise(setImmediate)
  stream.destroy(new Error('connection reset'))
  await pending
  expect(res.statusCode).toBe(429)
  expect(scheduler.markAccountRateLimited).toHaveBeenCalledWith('oauth-1', 'openai', null, null)
})

test('records API account quota and key rate-limit usage for generated images', async () => {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'api-1',
    accountType: 'openai-responses'
  })
  axios.post.mockResolvedValue({
    status: 200,
    data: { data: [{ b64_json: 'IMAGE' }], usage: { input_tokens: 10, output_tokens: 20 } }
  })
  const req = request()
  req.rateLimitInfo = { keyId: 'key-1' }
  const { updateRateLimitCounters } = require('../src/utils/rateLimitHelper')
  updateRateLimitCounters.mockResolvedValue({ totalTokens: 30, totalCost: 0.1 })
  await handleImages(req, response())
  expect(apiAccounts.updateUsageQuota).toHaveBeenCalledWith('api-1', 0.1)
  expect(updateRateLimitCounters).toHaveBeenCalledWith(
    req.rateLimitInfo,
    { inputTokens: 10, outputTokens: 20, cacheCreateTokens: 0, cacheReadTokens: 0 },
    'gpt-image-2',
    'key-1',
    'openai-responses',
    { realCost: 0.1, ratedCost: 0.1 }
  )
})

test('rejects a broken upstream stream and cleans listeners', async () => {
  const stream = new PassThrough()
  axios.post.mockResolvedValue({ status: 200, data: stream })
  const req = request()
  const res = response()
  const pending = handleImages(req, res)
  await new Promise(setImmediate)
  stream.destroy(new Error('connection reset'))
  await pending
  expect(res.statusCode).toBe(502)
  expect(req.listenerCount('aborted')).toBe(0)
  expect(res.listenerCount('close')).toBe(0)
})

test('API authentication errors honor disabled automatic protection', async () => {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'api-1',
    accountType: 'openai-responses'
  })
  apiAccounts.getAccount.mockResolvedValue({
    id: 'api-1',
    apiKey: 'secret',
    baseApi: 'https://api.openai.com',
    disableAutoProtection: 'true'
  })
  axios.post.mockResolvedValue({ status: 401, data: { error: { message: 'expired' } } })
  await handleImages(request(), response())
  expect(upstreamErrorHelper.markTempUnavailable).not.toHaveBeenCalled()
})

test('both route aliases relay gpt-image-2 through real HTTP to an API provider', async () => {
  const express = require('express')
  const supertest = require('supertest')
  const realAxios = jest.requireActual('axios')
  const provider = express()
  provider.use(express.json())
  const received = []
  const expected = {
    created: 123,
    data: [{ b64_json: 'IMAGE' }],
    usage: { input_tokens: 1, output_tokens: 2 }
  }
  provider.post('/v1/images/generations', (req, res) => {
    received.push({ headers: req.headers, body: req.body })
    res.json(expected)
  })
  const server = provider.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  try {
    scheduler.selectAccountForApiKey.mockResolvedValue({
      accountId: 'api-1',
      accountType: 'openai-responses'
    })
    apiAccounts.getAccount.mockResolvedValue({
      id: 'api-1',
      apiKey: 'provider-secret',
      baseApi: `http://127.0.0.1:${server.address().port}/v1`
    })
    axios.post.mockImplementation((url, body, options) =>
      realAxios.post(url, body, { ...options, proxy: false })
    )
    const app = express()
    app.use(express.json())
    app.use((req, res, next) => {
      req.apiKey = { id: 'key-1', openaiAccountId: 'responses:api-1' }
      next()
    })
    app.use('/openai', router)
    for (const path of ['/openai/images/generations', '/openai/v1/images/generations']) {
      const res = await supertest(app)
        .post(path)
        .set('Authorization', 'Bearer relay-secret')
        .send({ model: 'gpt-image-2', prompt: 'cat' })
      expect(res.status).toBe(200)
      expect(res.body).toEqual(expected)
    }
    expect(received).toHaveLength(2)
    for (const call of received) {
      expect(call.body).toMatchObject({ model: 'gpt-image-2', prompt: 'cat' })
      expect(call.headers.authorization).toBe('Bearer provider-secret')
      expect(call.headers['chatgpt-account-id']).toBeUndefined()
    }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})

test('real HTTP client disconnect destroys an active Codex stream', async () => {
  const express = require('express')
  const http = require('http')
  const stream = new PassThrough()
  let started
  const ready = new Promise((resolve) => {
    started = resolve
  })
  axios.post.mockImplementation(async () => {
    started()
    return { status: 200, data: stream }
  })
  const app = express()
  app.use(express.json())
  app.use('/openai', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  const client = http.request({
    hostname: '127.0.0.1',
    port: server.address().port,
    method: 'POST',
    path: '/openai/images/generations',
    headers: { 'content-type': 'application/json' }
  })
  client.on('error', () => {})
  try {
    client.end(JSON.stringify({ prompt: 'cat' }))
    await ready
    const closed = new Promise((resolve) => stream.once('close', resolve))
    client.destroy()
    await closed
    expect(stream.destroyed).toBe(true)
    expect(axios.post.mock.calls[0][2].signal.aborted).toBe(true)
  } finally {
    client.destroy()
    stream.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})

test('streams native image events and bills completed usage once', async () => {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'api-1',
    accountType: 'openai-responses'
  })
  const usage = {
    input_tokens: 100,
    output_tokens: 1000,
    input_tokens_details: { text_tokens: 100, image_tokens: 0 }
  }
  streamResponse(
    [
      { type: 'image_generation.partial_image', partial_image_index: 0, b64_json: 'PREVIEW' },
      { type: 'image_generation.completed', b64_json: 'FINAL', usage }
    ],
    { crlf: true, split: true }
  )
  const res = response()
  await handleImages(request({ stream: true, partial_images: 1 }), res)
  expect(axios.post.mock.calls[0][1].stream).toBe(true)
  expect(axios.post.mock.calls[0][2].responseType).toBe('stream')
  expect(res.chunks.join('')).toContain('image_generation.partial_image')
  expect(res.chunks.join('')).toContain('image_generation.completed')
  expect(res.writableEnded).toBe(true)
  expect(apiKeys.recordUsage).toHaveBeenCalledTimes(1)
  expect(apiKeys.recordUsage.mock.calls[0][10]).toEqual(usage)
})

test('converts Codex previews and final image to Images SSE events', async () => {
  streamResponse([preview(0), completed()])
  const res = response()
  await handleImages(request({ stream: true, partial_images: 1 }), res)
  expect(res.chunks.join('')).toContain('image_generation.partial_image')
  expect(res.chunks.join('')).toContain('image_generation.completed')
  expect(res.chunks.join('')).not.toContain('response.completed')
  expect(res.writableEnded).toBe(true)
})

test('bills reported Codex tool usage separately from outer text usage', async () => {
  const imageUsage = { input_tokens: 100, output_tokens: 1000 }
  streamResponse([
    { type: 'response.output_item.done', item: { ...imageItem(), usage: imageUsage } },
    completed()
  ])
  await handleImages(request(), response())
  expect(apiKeys.recordUsage).toHaveBeenCalledTimes(1)
  expect(apiKeys.recordUsage.mock.calls[0][5]).toBe('gpt-5.4-mini')
  expect(apiKeys.recordUsage.mock.calls[0][10]).toEqual({
    model: 'gpt-image-2',
    usages: [imageUsage]
  })
})

test('backpressure waits for drain and removes listeners', async () => {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'api-1',
    accountType: 'openai-responses'
  })
  streamResponse([
    {
      type: 'image_generation.completed',
      b64_json: 'FINAL',
      usage: { input_tokens: 1, output_tokens: 2 }
    }
  ])
  const res = response()
  res.write = function (chunk) {
    this.headersSent = true
    this.chunks.push(chunk)
    setImmediate(() => this.emit('drain'))
    return false
  }
  await handleImages(request({ stream: true }), res)
  expect(res.writableEnded).toBe(true)
  expect(res.listenerCount('drain')).toBe(0)
  expect(res.listenerCount('close')).toBe(0)
})

test('ends an SSE error after a preview and marks rate limited', async () => {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'api-1',
    accountType: 'openai-responses'
  })
  streamResponse([
    { type: 'image_generation.partial_image', b64_json: 'PREVIEW' },
    { type: 'error', code: 'rate_limit_exceeded', message: 'quota' }
  ])
  const res = response()
  await handleImages(request({ stream: true }), res)
  expect(res.chunks.join('')).toContain('event: error')
  expect(res.writableEnded).toBe(true)
  expect(scheduler.markAccountRateLimited).toHaveBeenCalled()
})

test('persists completed stream usage even when transport breaks afterwards', async () => {
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'api-1',
    accountType: 'openai-responses'
  })
  const stream = new PassThrough()
  axios.post.mockResolvedValue({ status: 200, data: stream })
  const res = response()
  const pending = handleImages(request({ stream: true }), res)
  stream.write(
    `data: ${JSON.stringify({
      type: 'image_generation.completed',
      b64_json: 'FINAL',
      usage: { input_tokens: 100, output_tokens: 1000 }
    })}\n\n`
  )
  await new Promise(setImmediate)
  stream.destroy(new Error('reset'))
  await pending
  expect(apiKeys.recordUsage).toHaveBeenCalledTimes(1)
  expect(res.writableEnded).toBe(true)
})

test('streams a preview over HTTP before upstream generation completes', async () => {
  const http = require('http')
  const express = require('express')
  const upstreamStream = new PassThrough()
  scheduler.selectAccountForApiKey.mockResolvedValue({
    accountId: 'api-1',
    accountType: 'openai-responses'
  })
  axios.post.mockResolvedValue({ status: 200, data: upstreamStream })
  const app = express()
  app.use(express.json())
  app.use('/openai', router)
  const server = app.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  let client
  try {
    await new Promise((resolve, reject) => {
      client = http.request(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/openai/v1/images/generations',
          method: 'POST',
          headers: { 'content-type': 'application/json' }
        },
        (res) => {
          let received = ''
          res.on('data', (chunk) => {
            received += chunk
            if (!upstreamStream.writableEnded && received.includes('PREVIEW')) {
              expect(res.headers['content-type']).toContain('text/event-stream')
              upstreamStream.end(
                `data: ${JSON.stringify({
                  type: 'image_generation.completed',
                  b64_json: 'FINAL',
                  usage: { input_tokens: 1, output_tokens: 2 }
                })}\n\n`
              )
            }
          })
          res.on('end', () => {
            expect(received).toContain('FINAL')
            resolve()
          })
          res.on('error', reject)
        }
      )
      client.on('error', reject)
      client.end(JSON.stringify({ prompt: 'cat', model: 'gpt-image-2', stream: true }))
      upstreamStream.write(
        `data: ${JSON.stringify({
          type: 'image_generation.partial_image',
          b64_json: 'PREVIEW',
          partial_image_index: 0
        })}\n\n`
      )
    })
    expect(apiKeys.recordUsage).toHaveBeenCalledTimes(1)
  } finally {
    client?.destroy()
    upstreamStream.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
})
