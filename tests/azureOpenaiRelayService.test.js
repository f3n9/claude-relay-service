jest.mock('axios', () => jest.fn())

jest.mock('../src/utils/proxyHelper', () => ({
  createProxyAgent: jest.fn(() => null),
  maskProxyInfo: jest.fn(() => null),
  getProxyDescription: jest.fn(() => 'no-proxy')
}))

jest.mock('../src/utils/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}))

jest.mock('../config/config', () => ({
  requestTimeout: 60000
}))

jest.mock('../src/utils/upstreamErrorHelper', () => ({
  markTempUnavailable: jest.fn()
}))

const axios = require('axios')
const { handleAzureOpenAIRequest } = require('../src/services/relay/azureOpenaiRelayService')

describe('azureOpenaiRelayService handleAzureOpenAIRequest', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    axios.mockResolvedValue({
      status: 200,
      headers: {},
      data: {}
    })
  })

  it('defaults embeddings requests to text-embedding-3-small when model is omitted', async () => {
    await handleAzureOpenAIRequest({
      account: {
        id: 'azure-account-1',
        azureEndpoint: 'https://example.openai.azure.com',
        deploymentName: 'embeddings-deployment',
        apiKey: 'azure-api-key'
      },
      requestBody: {
        input: 'hello embeddings'
      },
      endpoint: 'embeddings'
    })

    expect(axios).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.openai.azure.com/openai/deployments/embeddings-deployment/embeddings?api-version=2024-02-01',
        data: {
          input: 'hello embeddings',
          model: 'text-embedding-3-small'
        }
      })
    )
  })
})
