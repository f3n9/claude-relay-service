jest.useFakeTimers()
jest.mock('../config/config', () => ({ security: { encryptionKey: 'test-key' } }))
jest.mock('../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  success: jest.fn()
}))
jest.mock('../src/utils/upstreamErrorHelper', () => ({}))
jest.mock('../src/models/redis', () => {
  const hashes = new Map()
  const indexes = new Map()
  const client = {
    hset: jest.fn(async (key, data) => hashes.set(key, { ...hashes.get(key), ...data })),
    hgetall: jest.fn(async (key) => ({ ...hashes.get(key) })),
    sadd: jest.fn(),
    srem: jest.fn(),
    pipeline: () => {
      const keys = []
      return {
        hgetall: (key) => keys.push(key),
        exec: async () => keys.map((key) => [null, { ...hashes.get(key) }])
      }
    }
  }
  return {
    getClientSafe: () => client,
    addToIndex: async (key, id) => indexes.set(key, [...(indexes.get(key) || []), id]),
    getAllIdsByIndex: async (key) => indexes.get(key) || [],
    batchHgetallChunked: async (keys) => keys.map((key) => ({ ...hashes.get(key) })),
    getDateStringInTimezone: () => '2026-09-05',
    __hashes: hashes,
    __indexes: indexes,
    __client: client
  }
})
const redis = require('../src/models/redis')
const oauth = require('../src/services/account/openaiAccountService')
const api = require('../src/services/account/openaiResponsesAccountService')

beforeEach(() => {
  redis.__hashes.clear()
  redis.__indexes.clear()
  jest.clearAllMocks()
})
afterAll(() => {
  jest.clearAllTimers()
  jest.useRealTimers()
})

describe.each([
  ['OAuth', oauth, 'openai:account:', { name: 'test' }],
  [
    'Responses',
    api,
    'openai_responses_account:',
    { name: 'test', baseApi: 'https://provider.test', apiKey: 'secret' }
  ]
])('%s account discovery rules', (_type, service, prefix, options) => {
  test('persists create/edit, exposes parsed list/detail, preserves omitted fields and supports clearing', async () => {
    const patterns = ['gpt-5', 'gpt-5.6-*']
    const created = await service.createAccount({ ...options, modelDiscoveryPatterns: patterns })
    expect(created.modelDiscoveryPatterns).toEqual(patterns)
    expect(redis.__hashes.get(prefix + created.id).modelDiscoveryPatterns).toBe(
      JSON.stringify(patterns)
    )
    expect((await service.getAccount(created.id)).modelDiscoveryPatterns).toEqual(patterns)
    expect((await service.getAllAccounts())[0].modelDiscoveryPatterns).toEqual(patterns)
    await service.updateAccount(created.id, { name: 'renamed' })
    expect((await service.getAccount(created.id)).modelDiscoveryPatterns).toEqual(patterns)
    await service.updateAccount(created.id, { modelDiscoveryPatterns: ['gpt-4o'] })
    expect((await service.getAccount(created.id)).modelDiscoveryPatterns).toEqual(['gpt-4o'])
    await service.updateAccount(created.id, { modelDiscoveryPatterns: [] })
    expect((await service.getAccount(created.id)).modelDiscoveryPatterns).toEqual([])
  })
  test('persists disabling model listing and supports re-enabling it', async () => {
    const created = await service.createAccount({ ...options, disableModelListing: true })
    expect(created.disableModelListing).toBe(true)
    expect(redis.__hashes.get(prefix + created.id).disableModelListing).toBe('true')
    expect((await service.getAccount(created.id)).disableModelListing).toBe(true)
    expect((await service.getAllAccounts())[0].disableModelListing).toBe(true)
    await service.updateAccount(created.id, { name: 'renamed' })
    expect((await service.getAccount(created.id)).disableModelListing).toBe(true)
    await service.updateAccount(created.id, { disableModelListing: false })
    expect((await service.getAccount(created.id)).disableModelListing).toBe(false)
    expect(redis.__hashes.get(prefix + created.id).disableModelListing).toBe('false')
  })
  test('old accounts default to unrestricted discovery', async () => {
    const created = await service.createAccount(options)
    delete redis.__hashes.get(prefix + created.id).disableModelListing
    delete redis.__hashes.get(prefix + created.id).modelDiscoveryPatterns
    expect((await service.getAccount(created.id)).modelDiscoveryPatterns).toEqual([])
    expect((await service.getAllAccounts())[0].modelDiscoveryPatterns).toEqual([])
    expect((await service.getAccount(created.id)).disableModelListing).toBe(false)
    expect((await service.getAllAccounts())[0].disableModelListing).toBe(false)
  })
  test('invalid configuration is rejected without writing', async () => {
    await expect(
      service.createAccount({ ...options, modelDiscoveryPatterns: 'gpt-5' })
    ).rejects.toThrow('modelDiscoveryPatterns')
    expect(redis.__client.hset).not.toHaveBeenCalled()
    const created = await service.createAccount(options)
    redis.__client.hset.mockClear()
    await expect(
      service.updateAccount(created.id, { modelDiscoveryPatterns: [5] })
    ).rejects.toThrow('modelDiscoveryPatterns')
    expect(redis.__client.hset).not.toHaveBeenCalled()
  })
})
