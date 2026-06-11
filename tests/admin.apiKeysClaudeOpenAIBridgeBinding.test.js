const express = require('express')
const request = require('supertest')

jest.mock('../src/middleware/auth', () => ({
  authenticateAdmin: (req, res, next) => next()
}))

jest.mock('../src/models/redis', () => ({
  getApiKeysPaginated: jest.fn()
}))

jest.mock('../src/services/apiKeyService', () => ({
  generateApiKey: jest.fn(),
  updateApiKey: jest.fn()
}))

jest.mock('../src/services/requestBodyRuleService', () => ({
  normalizeRule: jest.fn((rule) => rule),
  validateAndNormalizeRules: jest.fn((rules) => ({ valid: true, rules: rules || [] }))
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  success: jest.fn()
}))

jest.mock('../config/config', () => ({}), { virtual: true })

const redis = require('../src/models/redis')
const apiKeyService = require('../src/services/apiKeyService')
const apiKeysRouter = require('../src/routes/admin/apiKeys')

describe('admin API key Claude OpenAI bridge bindings', () => {
  const buildApp = () => {
    const app = express()
    app.use(express.json())
    app.use('/admin', apiKeysRouter)
    return app
  }

  beforeEach(() => {
    jest.clearAllMocks()
    apiKeyService.generateApiKey.mockResolvedValue({ id: 'key-1' })
    apiKeyService.updateApiKey.mockResolvedValue({ success: true })
  })

  it('counts API keys bound to claude-openai-bridge accounts', async () => {
    redis.getApiKeysPaginated.mockResolvedValue({
      items: [
        { id: 'key-1', claudeOpenAIBridgeAccountId: 'bridge-1' },
        { id: 'key-2', claudeOpenAIBridgeAccountId: 'bridge-1' },
        { id: 'key-3', claudeOpenAIBridgeAccountId: 'bridge-2' }
      ]
    })

    const response = await request(buildApp()).get('/admin/accounts/binding-counts')

    expect(response.status).toBe(200)
    expect(response.body.data.claudeOpenAIBridgeAccountId).toEqual({
      'bridge-1': 2,
      'bridge-2': 1
    })
  })

  it('passes claude-openai-bridge binding through create and update API key routes', async () => {
    const app = buildApp()

    await request(app).post('/admin/api-keys').send({
      name: 'Bridge key',
      claudeOpenAIBridgeAccountId: 'bridge-1'
    })
    await request(app).put('/admin/api-keys/key-1').send({
      claudeOpenAIBridgeAccountId: 'bridge-2'
    })

    expect(apiKeyService.generateApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeOpenAIBridgeAccountId: 'bridge-1'
      })
    )
    expect(apiKeyService.updateApiKey).toHaveBeenCalledWith(
      'key-1',
      expect.objectContaining({
        claudeOpenAIBridgeAccountId: 'bridge-2'
      })
    )
  })
})
