const { PassThrough } = require('stream')

jest.mock('axios', () => ({
  post: jest.fn()
}))

jest.mock('../src/models/redis', () => ({}))

jest.mock('../src/services/apiKeyService', () => ({
  validateApiKeyForStats: jest.fn(),
  hasPermission: jest.fn()
}))

jest.mock('../src/utils/costCalculator', () => ({}))
jest.mock('../src/services/account/claudeAccountService', () => ({}))
jest.mock('../src/services/account/openaiAccountService', () => ({}))
jest.mock('../src/services/serviceRatesService', () => ({}))

jest.mock('../src/utils/testPayloadHelper', () => ({
  createClaudeTestPayload: jest.fn(),
  createOpenAITestPayload: jest.fn(),
  extractErrorMessage: jest.fn((payload, fallback) => payload?.error?.message || fallback),
  sanitizeErrorMsg: jest.fn((msg) => msg)
}))

jest.mock('../src/utils/errorSanitizer', () => ({
  getSafeMessage: jest.fn((value) => (value && value.message ? value.message : String(value || '')))
}))

jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  api: jest.fn(),
  security: jest.fn()
}))

jest.mock('../config/models', () => ({
  getModelsByService: jest.fn(() => []),
  CLAUDE_MODELS: [],
  GEMINI_MODELS: [],
  OPENAI_MODELS: [],
  OTHER_MODELS: [],
  PLATFORM_TEST_MODELS: [],
  getAllModels: jest.fn(() => [])
}))

jest.mock('../config/config', () => ({
  server: { port: 3000 }
}))

const axios = require('axios')
const apiKeyService = require('../src/services/apiKeyService')
const { createOpenAITestPayload } = require('../src/utils/testPayloadHelper')
const router = require('../src/routes/apiStats')

function getOpenAITestHandler() {
  const routeLayer = router.stack.find(
    (layer) =>
      layer.route && layer.route.path === '/api-key/test-openai' && layer.route.methods.post
  )
  return routeLayer.route.stack[routeLayer.route.stack.length - 1].handle
}

describe('apiStats OpenAI SSE test relay', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.validateApiKeyForStats.mockResolvedValue({
      valid: true,
      keyData: {
        id: 'key-1',
        name: 'Test Key',
        permissions: ['openai']
      }
    })
    apiKeyService.hasPermission.mockReturnValue(true)
    createOpenAITestPayload.mockReturnValue({
      model: 'gpt-5',
      stream: true,
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }]
    })
  })

  it('relays response.custom_tool_call_input.* events in test-openai SSE stream', async () => {
    const stream = new PassThrough()
    axios.post.mockResolvedValue({
      status: 200,
      data: stream
    })

    const handler = getOpenAITestHandler()
    const req = {
      body: {
        apiKey: 'sk-test-openai-key',
        model: 'gpt-5',
        prompt: 'hi'
      }
    }

    const writes = []
    const res = {
      headersSent: false,
      writeHead: jest.fn(),
      write: jest.fn((chunk) => {
        writes.push(String(chunk))
      }),
      end: jest.fn(),
      status: jest.fn().mockReturnThis(),
      json: jest.fn().mockReturnThis()
    }

    const finished = new Promise((resolve) => {
      res.end.mockImplementation(resolve)
    })

    await handler(req, res)

    setImmediate(() => {
      stream.write(
        `data: ${JSON.stringify({ type: 'response.custom_tool_call_input.delta', delta: '{"x":1' })}\n\n`
      )
      stream.write(
        `data: ${JSON.stringify({ type: 'response.custom_tool_call_input.done', arguments: '{"x":1}' })}\n\n`
      )
      stream.write(
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`
      )
      stream.end()
    })

    await finished

    expect(createOpenAITestPayload).toHaveBeenCalledWith('gpt-5', {
      prompt: 'hi',
      maxTokens: 1000
    })
    expect(writes.join('')).toContain('response.custom_tool_call_input.delta')
    expect(writes.join('')).toContain('response.custom_tool_call_input.done')
    expect(writes.join('')).toContain('"type":"content"')
  })
})
