const http = require('http')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PassThrough } = require('stream')
const express = require('express')
const supertest = require('supertest')
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime')

const mockLogDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-error-logs-'))
const mockLoggers = []

jest.mock('../config/config', () => ({
  logging: { dirname: mockLogDirectory, level: 'error', maxSize: '20m', maxFiles: '1d' },
  system: { timezoneOffset: 8 }
}))
jest.mock('winston', () => {
  const actual = jest.requireActual('winston')
  return {
    ...actual,
    createLogger: (...args) => {
      const instance = actual.createLogger(...args)
      for (const transport of instance.transports) {
        if (transport instanceof actual.transports.Console) {
          transport.silent = true
        }
      }
      mockLoggers.push(instance)
      return instance
    }
  }
})

const logger = require('../src/utils/logger')
const {
  createLoggedAxios,
  createLoggedHttpsRequest,
  runWithUpstreamRequestContext,
  bedrockLoggingMiddleware
} = require('../src/utils/upstreamErrorLogger')

describe('upstream error logging with real transports', () => {
  let server
  let upstreamUrl
  let logSpy
  let infoSpy

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/completed-stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        res.write('data: {"type":"response.completed","response":{"status":"completed"}}\n\n')
        // 保持 HTTP 流打开，模拟客户端读到完成事件后主动关闭。
        return
      }
      res.writeHead(503, { 'x-upstream-id': 'real-upstream', 'Content-Type': 'application/json' })
      res.write('{"error":{"message":"')
      res.end(`${'完整错误😀'.repeat(15000)}"}}`)
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    upstreamUrl = `http://127.0.0.1:${server.address().port}/v1/messages`
    logSpy = jest.spyOn(logger, 'error')
    infoSpy = jest.spyOn(logger, 'info')
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    logSpy?.mockRestore()
    infoSpy?.mockRestore()
    for (const instance of mockLoggers) {
      instance.close()
    }
    fs.rmSync(mockLogDirectory, { recursive: true, force: true })
  })

  it('records original client body through Express and real Axios streaming errors', async () => {
    const client = createLoggedAxios(require('axios'), 'integration')
    const app = express()
    app.use(express.json({ limit: '100mb' }))
    app.use((req, res, next) => {
      req.requestId = 'integration-request'
      req.apiKey = { id: 'integration-key', name: '集成测试 Key' }
      runWithUpstreamRequestContext(req, next)
    })
    app.post('/v1/messages', async (req, res) => {
      req.body = { model: 'mapped-model', messages: [] }
      const response = await client({
        url: upstreamUrl,
        method: 'POST',
        data: req.body,
        responseType: 'stream',
        validateStatus: () => true,
        proxy: false
      })
      res.status(response.status)
      res.type('application/json')
      response.data.pipe(res)
    })
    const body = {
      model: 'client-model',
      messages: [{ role: 'user', content: '完整请求😀'.repeat(15000) }]
    }
    const result = await supertest(app).post('/v1/messages').send(body).expect(503)
    expect(result.body.error.message).toBe('完整错误😀'.repeat(15000))
    const data = logSpy.mock.calls.find(([, info]) => info?.provider === 'integration')[1]
    expect(data).toMatchObject({
      apiKeyName: '集成测试 Key',
      modelId: 'client-model',
      requestBody: body,
      upstreamRequestBody: { model: 'mapped-model', messages: [] },
      upstreamStatus: 503,
      upstreamResponseHeaders: { 'x-upstream-id': 'real-upstream' }
    })

    // 检查实际 NDJSON 输出，不能只验证 logger mock：超过 50KB 的 body 和 emoji 必须完整。
    await new Promise((resolve) => setTimeout(resolve, 30))
    const entries = fs
      .readdirSync(mockLogDirectory)
      .filter((filename) => /^claude-relay-error-.*\.log$/.test(filename))
      .flatMap((filename) =>
        fs
          .readFileSync(path.join(mockLogDirectory, filename), 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      )
    const written = entries.find((entry) => entry.provider === 'integration')
    expect(written.requestBody).toEqual(body)
    expect(written.upstreamResponseBody).toBe(result.text)
    expect(written._truncated).toBeUndefined()
  })

  it('captures a real native HTTP response without consuming it before the relay', async () => {
    const send = createLoggedHttpsRequest(http, {
      provider: 'native-integration',
      requestBody: '{}'
    })
    const value = await new Promise((resolve, reject) => {
      const upstream = send(
        {
          hostname: '127.0.0.1',
          port: server.address().port,
          path: '/v1/messages',
          method: 'POST'
        },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(chunk))
          response.on('end', () => resolve(Buffer.concat(chunks).toString()))
        }
      )
      upstream.on('error', reject)
      upstream.end('{}')
    })
    const data = logSpy.mock.calls.find(([, info]) => info?.provider === 'native-integration')[1]
    expect(data.upstreamResponseBody).toBe(value)
    expect(data.upstreamStatus).toBe(503)
  })

  it('logs actual Axios cancellation after a model completion event as info', async () => {
    const controller = new AbortController()
    const client = createLoggedAxios(require('axios'), 'completed-stream-test')
    const response = await client({
      url: upstreamUrl.replace('/v1/messages', '/completed-stream'),
      method: 'POST',
      data: { model: 'test-model', stream: true },
      responseType: 'stream',
      signal: controller.signal,
      proxy: false
    })
    const chunks = []
    const error = await new Promise((resolve) => {
      response.data.once('error', resolve)
      response.data.on('data', (chunk) => {
        chunks.push(chunk)
        if (Buffer.concat(chunks).toString().includes('response.completed')) {
          controller.abort('client_disconnected')
        }
      })
    })
    expect(error.code).toBe('ERR_CANCELED')
    expect(Buffer.concat(chunks).toString()).toContain('response.completed')
    expect(
      logSpy.mock.calls.filter(([, data]) => data?.provider === 'completed-stream-test')
    ).toEqual([])
    expect(infoSpy).toHaveBeenCalledWith(
      'Upstream model request canceled',
      expect.objectContaining({
        type: 'upstream_canceled',
        provider: 'completed-stream-test',
        upstreamStatus: 200,
        cancellationReason: 'client_disconnected',
        errorCode: 'ERR_CANCELED'
      })
    )
  })

  it('captures Bedrock errors before the real SDK consumes their HTTP body', async () => {
    const client = new BedrockRuntimeClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'test-access-key', secretAccessKey: 'test-secret-key' },
      maxAttempts: 1,
      requestHandler: {
        handle: async () => {
          const body = new PassThrough()
          setImmediate(() => body.end('{"message":"access denied","extra":"upstream body field"}'))
          return {
            response: {
              statusCode: 403,
              headers: {
                'content-type': 'application/json',
                'x-amzn-requestid': 'sdk-test',
                'x-amzn-errortype': 'AccessDeniedException'
              },
              body
            }
          }
        }
      }
    })
    client.middlewareStack.add(bedrockLoggingMiddleware, {
      step: 'deserialize',
      name: 'bedrockUpstreamErrorLogging',
      priority: 'low'
    })
    await expect(
      runWithUpstreamRequestContext(
        {
          requestId: 'sdk-request',
          apiKey: { name: 'SDK测试 Key' },
          body: { model: 'client-model' }
        },
        () =>
          client.send(
            new InvokeModelCommand({
              modelId: 'upstream-model',
              contentType: 'application/json',
              body: '{"messages":[]}'
            })
          )
      )
    ).rejects.toMatchObject({ name: 'AccessDeniedException' })
    const data = logSpy.mock.calls.find(([, info]) => info?.provider === 'bedrock')[1]
    expect(data).toMatchObject({
      apiKeyName: 'SDK测试 Key',
      upstreamStatus: 403,
      upstreamResponseHeaders: { 'x-amzn-requestid': 'sdk-test' },
      upstreamResponseBody: '{"message":"access denied","extra":"upstream body field"}'
    })
    client.destroy()
  })
})
