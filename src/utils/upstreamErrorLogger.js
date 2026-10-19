const { AsyncLocalStorage } = require('async_hooks')
const zlib = require('zlib')
const logger = require('./logger')

const requestContext = new AsyncLocalStorage()
const observedStreams = new WeakSet()
const observedResponses = new WeakSet()
const observedErrors = new WeakSet()
const geminiLoggingInstallations = new WeakMap()
const SECRET_HEADERS =
  /^(authorization|proxy-authorization|x-api-key|api-key|x-goog-api-key|cookie|set-cookie)$/i
const SECRET_QUERY_PARAMS = /^(key|api[-_]?key|access_token|token|sig|signature)$/i

function snapshot(value) {
  if (value === undefined || value === null) {
    return null
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8')
  }
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return '[Unable to serialize value]'
  }
}

// 在路由修改模型、转换协议或应用 payload rules 之前保留客户端请求。
function runWithUpstreamRequestContext(req, next) {
  if (requestContext.getStore()?.requestId === req.requestId && req.requestId) {
    return next()
  }
  const modelFromUrl = (req.originalUrl || req.url || '').match(/\/models\/([^/:?]+)(?::|\/|\?|$)/)
  return requestContext.run(
    {
      requestId: req.requestId || null,
      apiKeyId: req.apiKey?.id || null,
      apiKeyName: req.apiKey?.name || req.apiKey?.id || null,
      modelId: req.body?.model || req.params?.modelName || modelFromUrl?.[1] || null,
      requestBody: snapshot(req.body)
    },
    next
  )
}

function sanitizeHeaders(headers) {
  if (!headers) {
    return null
  }
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => [
      key,
      SECRET_HEADERS.test(key) ? '[REDACTED_SECRET]' : snapshot(value)
    ])
  )
}

function sanitizeUrl(url) {
  if (!url) {
    return null
  }
  try {
    const parsed = new URL(url)
    parsed.username = ''
    parsed.password = ''
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SECRET_QUERY_PARAMS.test(key)) {
        parsed.searchParams.set(key, '[REDACTED_SECRET]')
      }
    }
    return parsed.toString()
  } catch {
    return null
  }
}

function hasModelError(body) {
  if (body && typeof body === 'object') {
    return Boolean(
      body.error ||
        body.type === 'error' ||
        body.type === 'response.failed' ||
        body.response?.error ||
        body.response?.status === 'failed' ||
        body.status === 'failed'
    )
  }
  if (typeof body !== 'string') {
    return false
  }
  try {
    return hasModelError(JSON.parse(body))
  } catch {
    // Anthropic、OpenAI Responses 和 Gemini 在 HTTP 200 的 SSE 中也可能返回错误。
    return body.split(/\r?\n\r?\n/).some((event) => {
      if (/^event:\s*(error|response\.failed)\s*$/m.test(event)) {
        return true
      }
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      try {
        return Boolean(data && data !== '[DONE]' && hasModelError(JSON.parse(data)))
      } catch {
        return false
      }
    })
  }
}

function logUpstreamError({
  provider,
  url,
  requestBody,
  context = requestContext.getStore(),
  status = null,
  statusText = null,
  headers = null,
  body = null,
  error = null,
  responseBodyComplete = true
}) {
  // 日志故障不能改变上游返回值或错误处理流程。只记录名称，不记录 APIKey 凭证。
  try {
    logger.error('Upstream model request failed', {
      type: 'upstream_error',
      provider,
      requestId: context?.requestId || null,
      apiKeyId: context?.apiKeyId || null,
      apiKeyName: context?.apiKeyName || null,
      modelId: context?.modelId || requestBody?.model || requestBody?.request?.model || null,
      requestBody: context ? context.requestBody : snapshot(requestBody),
      upstreamUrl: sanitizeUrl(url),
      upstreamRequestBody: snapshot(requestBody),
      upstreamStatus: status,
      upstreamStatusText: statusText,
      upstreamResponseHeaders: sanitizeHeaders(headers),
      upstreamResponseBody: snapshot(body),
      responseBodyComplete,
      errorCode: error?.code || error?.name || null,
      errorMessage: error?.message || null
    })
  } catch {
    // Preserve relay behavior if the logging transport is unavailable.
  }
}

function decodeBody(chunks, headers, compressed) {
  let bytes = Buffer.concat(chunks)
  if (compressed) {
    try {
      switch (headers?.['content-encoding']) {
        case 'gzip':
          bytes = zlib.gunzipSync(bytes)
          break
        case 'deflate':
          bytes = zlib.inflateSync(bytes)
          break
        case 'br':
          bytes = zlib.brotliDecompressSync(bytes)
          break
      }
    } catch {
      // 部分响应或无效压缩数据仍保留实际收到的内容。
    }
  }
  return bytes.toString('utf8')
}

function observeUpstreamResponse(response, details = {}) {
  if (observedResponses.has(response)) {
    return response
  }
  observedResponses.add(response)
  const status = response.status ?? response.statusCode ?? null
  const headers = response.headers || null
  const body = response.data !== undefined ? response.data : response.body
  const stream = body && typeof body.push === 'function' ? body : response
  const info = {
    ...details,
    context: details.context || requestContext.getStore(),
    status,
    statusText: response.statusText || response.statusMessage || null,
    headers
  }
  const failed = status !== null && (status < 200 || status >= 300)

  if (!stream || typeof stream.push !== 'function') {
    const value = snapshot(body)
    if (failed || details.error || hasModelError(value)) {
      logUpstreamError({ ...info, body: value })
    }
    return response
  }
  if (observedStreams.has(stream)) {
    return response
  }
  observedStreams.add(stream)

  // 被动观察 push，不添加 data 监听器或提前消费流，保持流速、背压和响应对象不变。
  // Axios 返回前可能已经收到首批数据，连同缓冲区中的数据一起保留。
  let chunks = Array.from(stream.readableBuffer || [], (chunk) => Buffer.from(chunk))
  let finished = false
  const originalPush = stream.push
  const finish = (error = null, complete = true) => {
    if (finished) {
      return
    }
    finished = true
    stream.push = originalPush
    const value = decodeBody(chunks, headers, details.compressed)
    chunks = []
    if (failed || error || details.error || hasModelError(value)) {
      logUpstreamError({
        ...info,
        body: value,
        error: error || details.error,
        responseBodyComplete: complete
      })
    }
  }
  stream.push = function (chunk, encoding) {
    if (chunk === null) {
      finish()
    } else {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding))
    }
    return originalPush.call(this, chunk, encoding)
  }
  stream.once('error', (error) => finish(error, false))
  stream.once('aborted', () => finish(new Error('Upstream response aborted'), false))
  stream.once('close', () => {
    if (!finished) {
      finish(new Error('Upstream response closed before completion'), false)
    }
  })
  if (stream.readableEnded || stream._readableState?.ended) {
    finish()
  }
  return response
}

function createLoggedAxios(axios, provider) {
  const invoke = async (send, options) => {
    const details = {
      provider,
      url: options.url,
      requestBody: snapshot(options.data),
      context: requestContext.getStore()
    }
    try {
      const response = await send()
      return observeUpstreamResponse(response, details)
    } catch (error) {
      observeAxiosError(error, details)
      throw error
    }
  }
  const client = (options) => invoke(() => axios(options), options)
  client.post = (url, data, options = {}) =>
    invoke(() => axios.post(url, data, options), { ...options, url, data })
  client.get = (url, options = {}) => invoke(() => axios.get(url, options), { ...options, url })
  return client
}

function observeAxiosError(error, details) {
  if (observedErrors.has(error)) {
    return
  }
  observedErrors.add(error)
  if (error.response) {
    observeUpstreamResponse(error.response, { ...details, error })
  } else {
    logUpstreamError({ ...details, error, responseBodyComplete: false })
  }
}

// Gemini account helpers use the default Axios instance. Observe only model endpoints;
// OAuth token exchanges and account setup requests must retain their existing behavior.
function installGeminiUpstreamLogging(axios) {
  if (geminiLoggingInstallations.has(axios)) {
    return geminiLoggingInstallations.get(axios)
  }
  const requests = new WeakMap()
  const requestInterceptor = axios.interceptors.request.use((options) => {
    try {
      const url = new URL(options.url, options.baseURL)
      if (
        url.hostname === 'cloudcode-pa.googleapis.com' &&
        /^\/v1internal:(generateContent|streamGenerateContent|countTokens)$/.test(url.pathname)
      ) {
        requests.set(options, {
          provider: 'gemini',
          url: url.toString(),
          requestBody: snapshot(options.data),
          context: requestContext.getStore()
        })
      }
    } catch {
      // URL validation belongs to Axios, not logging.
    }
    return options
  })
  const responseInterceptor = axios.interceptors.response.use(
    (response) => {
      const details = requests.get(response.config)
      if (details) {
        observeUpstreamResponse(response, details)
      }
      return response
    },
    (error) => {
      const details = requests.get(error.config)
      if (details) {
        observeAxiosError(error, details)
      }
      return Promise.reject(error)
    }
  )
  const removeLogging = () => {
    axios.interceptors.request.eject(requestInterceptor)
    axios.interceptors.response.eject(responseInterceptor)
    geminiLoggingInstallations.delete(axios)
  }
  geminiLoggingInstallations.set(axios, removeLogging)
  return removeLogging
}

// 原生 HTTPS 路径与 Axios 共用观察器；网络错误没有上游响应时明确记录 null。
function createLoggedHttpsRequest(https, details = {}) {
  return (options, callback) => loggedHttpsRequest(https, options, callback, details)
}

function loggedHttpsRequest(https, options, callback, details) {
  const info = {
    ...details,
    context: requestContext.getStore(),
    url: `https://${options.hostname}${options.port ? `:${options.port}` : ''}${options.path}`
  }
  let responseReceived = false
  let failureLogged = false
  const logFailure = (error) => {
    if (!failureLogged) {
      failureLogged = true
      logUpstreamError({ ...info, error, responseBodyComplete: false })
    }
  }
  let request
  try {
    request = https.request(options, (response) => {
      responseReceived = true
      observeUpstreamResponse(response, { ...info, compressed: true })
      return callback(response)
    })
  } catch (error) {
    logFailure(error)
    throw error
  }
  request.once('error', (error) => {
    if (!responseReceived) {
      logFailure(error)
    }
  })
  request.once('timeout', () => {
    if (!responseReceived) {
      logFailure(Object.assign(new Error('Upstream request timed out'), { code: 'ETIMEDOUT' }))
    }
  })
  return request
}

// 在 AWS SDK 反序列化之前观察原始 HTTP 响应，避免错误 body 被 SDK 消费后丢失。
function bedrockLoggingMiddleware(next) {
  return async (args) => {
    const details = {
      provider: 'bedrock',
      url: args.request ? `https://${args.request.hostname}${args.request.path}` : null,
      requestBody: snapshot(args.request?.body),
      context: requestContext.getStore()
    }
    try {
      const result = await next(args)
      // 成功的 AWS eventstream 是二进制协议，在解码后的事件层检查模型错误。
      if (
        !/application\/vnd\.amazon\.eventstream/i.test(result.response.headers?.['content-type'])
      ) {
        observeUpstreamResponse(result.response, details)
      }
      return result
    } catch (error) {
      logUpstreamError({ ...details, error, responseBodyComplete: false })
      throw error
    }
  }
}

async function* observeBedrockEventStream(response, requestBody) {
  const details = {
    provider: 'bedrock',
    requestBody: snapshot(requestBody),
    context: requestContext.getStore(),
    status: response.$metadata?.httpStatusCode || 200,
    headers: response._upstreamResponseHeaders || null
  }
  const events = []
  let failed = false
  try {
    for await (const event of response.body) {
      const value = event.chunk?.bytes
        ? Buffer.from(event.chunk.bytes).toString('utf8')
        : snapshot(event)
      events.push(value)
      if (hasModelError(value) || Object.keys(event).some((key) => /exception$/i.test(key))) {
        failed = true
      }
      yield event
    }
    if (failed) {
      logUpstreamError({ ...details, body: events })
    }
  } catch (error) {
    logUpstreamError({ ...details, body: events, error, responseBodyComplete: false })
    throw error
  }
}

module.exports = {
  runWithUpstreamRequestContext,
  createLoggedAxios,
  installGeminiUpstreamLogging,
  observeUpstreamResponse,
  logUpstreamError,
  createLoggedHttpsRequest,
  bedrockLoggingMiddleware,
  observeBedrockEventStream
}
