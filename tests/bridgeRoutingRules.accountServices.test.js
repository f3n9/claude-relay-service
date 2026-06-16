const storedRules = JSON.stringify([
  {
    sourceModel: 'deepseek-v4-flash',
    bridgeAccountId: 'bridge-1',
    targetModel: 'DeepSeek-V4-Flash',
    enabled: true
  }
])

const inputRules = [
  {
    sourceModel: ' deepseek-v4-flash ',
    bridgeAccountId: ' bridge-1 ',
    targetModel: ' DeepSeek-V4-Flash ',
    enabled: true
  }
]

const normalizedRules = [
  {
    sourceModel: 'deepseek-v4-flash',
    bridgeAccountId: 'bridge-1',
    targetModel: 'DeepSeek-V4-Flash',
    enabled: true
  }
]

function installCommonMocks() {
  jest.doMock('../src/utils/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    debug: jest.fn()
  }))
  jest.doMock(
    '../config/config',
    () => ({
      security: { encryptionKey: 'test-encryption-key' },
      claude: {},
      gcpVertex: {}
    }),
    { virtual: true }
  )
  jest.doMock('google-auth-library', () => ({
    GoogleAuth: jest.fn()
  }))
  jest.doMock('../src/utils/commonHelper', () => ({
    createEncryptor: jest.fn(() => ({
      encrypt: jest.fn((value) => `enc:${value}`),
      decrypt: jest.fn((value) => String(value || '').replace(/^enc:/, '')),
      clearCache: jest.fn(),
      getStats: jest.fn(() => ({}))
    })),
    sortAccountsByPriority: jest.fn((accounts) => accounts)
  }))
}

function loadServiceWithRedis(servicePath, redisMock) {
  jest.resetModules()
  installCommonMocks()
  jest.doMock('../src/models/redis', () => redisMock)
  return require(servicePath)
}

describe('source account bridge routing rule persistence', () => {
  it('persists bridge routing rules on Claude official accounts', async () => {
    const redis = {
      setClaudeAccount: jest.fn(async () => {}),
      getClaudeAccount: jest.fn(async () => ({
        id: 'claude-1',
        name: 'Claude 1',
        email: '',
        password: '',
        refreshToken: '',
        accessToken: '',
        isActive: 'true',
        status: 'active',
        accountType: 'shared',
        platform: 'claude',
        priority: '50',
        schedulable: 'true',
        bridgeRoutingRules: storedRules
      })),
      getAllClaudeAccounts: jest.fn(async () => [
        {
          id: 'claude-1',
          name: 'Claude 1',
          email: '',
          isActive: 'true',
          status: 'active',
          accountType: 'shared',
          platform: 'claude',
          priority: '50',
          schedulable: 'true',
          bridgeRoutingRules: storedRules
        }
      ])
    }
    const service = loadServiceWithRedis('../src/services/account/claudeAccountService', redis)

    const created = await service.createAccount({
      name: 'Claude 1',
      bridgeRoutingRules: inputRules
    })

    expect(redis.setClaudeAccount.mock.calls[0][1].bridgeRoutingRules).toBe(storedRules)
    expect(created.bridgeRoutingRules).toEqual(normalizedRules)

    await service.updateAccount('claude-1', { bridgeRoutingRules: inputRules })

    expect(redis.setClaudeAccount.mock.calls[1][1].bridgeRoutingRules).toBe(storedRules)
    await expect(service.getAccount('claude-1')).resolves.toMatchObject({
      bridgeRoutingRules: normalizedRules
    })
    await expect(service.getAllAccounts()).resolves.toEqual([
      expect.objectContaining({
        bridgeRoutingRules: normalizedRules
      })
    ])
  })

  it('persists bridge routing rules on Claude Console accounts', async () => {
    const hashes = new Map()
    const client = {
      hset: jest.fn(async (key, value) => {
        hashes.set(key, { ...(hashes.get(key) || {}), ...value })
      }),
      hgetall: jest.fn(async (key) => ({ ...(hashes.get(key) || {}) })),
      sadd: jest.fn(),
      srem: jest.fn()
    }
    const redis = {
      getClientSafe: () => client,
      addToIndex: jest.fn(),
      getAllIdsByIndex: jest.fn(async () => ['console-1']),
      batchHgetallChunked: jest.fn(async () => [
        { ...(hashes.get('claude_console_account:console-1') || {}) }
      ]),
      getConsoleAccountConcurrency: jest.fn(async () => 0),
      getDateStringInTimezone: jest.fn(() => '2026-06-16')
    }
    const service = loadServiceWithRedis(
      '../src/services/account/claudeConsoleAccountService',
      redis
    )

    const created = await service.createAccount({
      name: 'Console 1',
      apiUrl: 'https://console.example.com',
      apiKey: 'secret',
      bridgeRoutingRules: inputRules
    })
    const key = `claude_console_account:${created.id}`

    expect(hashes.get(key).bridgeRoutingRules).toBe(storedRules)
    expect(created.bridgeRoutingRules).toEqual(normalizedRules)

    await service.updateAccount(created.id, { bridgeRoutingRules: inputRules })

    expect(hashes.get(key).bridgeRoutingRules).toBe(storedRules)
    await expect(service.getAccount(created.id)).resolves.toMatchObject({
      bridgeRoutingRules: normalizedRules
    })
    hashes.set('claude_console_account:console-1', hashes.get(key))
    await expect(service.getAllAccounts()).resolves.toEqual([
      expect.objectContaining({
        bridgeRoutingRules: normalizedRules
      })
    ])
  })

  it('persists bridge routing rules on GCP Vertex accounts', async () => {
    const values = new Map()
    const client = {
      set: jest.fn(async (key, value) => values.set(key, value)),
      get: jest.fn(async (key) => values.get(key) || null)
    }
    const redis = {
      getClientSafe: () => client,
      addToIndex: jest.fn(),
      getAllIdsByIndex: jest.fn(async () => ['vertex-1']),
      batchGetChunked: jest.fn(async () => [values.get('claude_vertex_account:vertex-1')])
    }
    const service = loadServiceWithRedis('../src/services/account/gcpVertexAccountService', redis)
    const serviceAccountJson = {
      project_id: 'project-1',
      private_key: 'private-key',
      client_email: 'svc@example.com'
    }

    const result = await service.createAccount({
      name: 'Vertex 1',
      serviceAccountJson,
      bridgeRoutingRules: inputRules
    })
    const key = `claude_vertex_account:${result.data.id}`

    expect(JSON.parse(values.get(key)).bridgeRoutingRules).toEqual(normalizedRules)
    expect(result.data.bridgeRoutingRules).toEqual(normalizedRules)

    await service.updateAccount(result.data.id, { bridgeRoutingRules: inputRules })

    expect(JSON.parse(values.get(key)).bridgeRoutingRules).toEqual(normalizedRules)
    await expect(service.getAccount(result.data.id)).resolves.toMatchObject({
      bridgeRoutingRules: normalizedRules
    })
    values.set('claude_vertex_account:vertex-1', values.get(key))
    await expect(service.getAllAccounts()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          bridgeRoutingRules: normalizedRules
        })
      ]
    })
  })

  it('persists bridge routing rules on Bedrock accounts', async () => {
    const values = new Map()
    const client = {
      set: jest.fn(async (key, value) => values.set(key, value)),
      get: jest.fn(async (key) => values.get(key) || null)
    }
    const redis = {
      getClientSafe: () => client,
      addToIndex: jest.fn(),
      getAllIdsByIndex: jest.fn(async () => ['bedrock-1']),
      batchGetChunked: jest.fn(async () => [values.get('bedrock_account:bedrock-1')])
    }
    const service = loadServiceWithRedis('../src/services/account/bedrockAccountService', redis)

    const result = await service.createAccount({
      name: 'Bedrock 1',
      awsCredentials: {
        accessKeyId: 'ak',
        secretAccessKey: 'sk'
      },
      bridgeRoutingRules: inputRules
    })
    const key = `bedrock_account:${result.data.id}`

    expect(JSON.parse(values.get(key)).bridgeRoutingRules).toEqual(normalizedRules)
    expect(result.data.bridgeRoutingRules).toEqual(normalizedRules)

    await service.updateAccount(result.data.id, { bridgeRoutingRules: inputRules })

    expect(JSON.parse(values.get(key)).bridgeRoutingRules).toEqual(normalizedRules)
    await expect(service.getAccount(result.data.id)).resolves.toMatchObject({
      success: true,
      data: expect.objectContaining({
        bridgeRoutingRules: normalizedRules
      })
    })
    values.set('bedrock_account:bedrock-1', values.get(key))
    await expect(service.getAllAccounts()).resolves.toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          bridgeRoutingRules: normalizedRules
        })
      ]
    })
  })

  it('persists bridge routing rules on CCR accounts', async () => {
    const hashes = new Map()
    const client = {
      hset: jest.fn(async (key, value) => {
        hashes.set(key, { ...(hashes.get(key) || {}), ...value })
      }),
      hgetall: jest.fn(async (key) => ({ ...(hashes.get(key) || {}) })),
      sadd: jest.fn(),
      srem: jest.fn()
    }
    const redis = {
      getClientSafe: () => client,
      addToIndex: jest.fn(),
      getAllIdsByIndex: jest.fn(async () => ['ccr-1']),
      batchHgetallChunked: jest.fn(async () => [{ ...(hashes.get('ccr_account:ccr-1') || {}) }]),
      getDateStringInTimezone: jest.fn(() => '2026-06-16')
    }
    const service = loadServiceWithRedis('../src/services/account/ccrAccountService', redis)

    const created = await service.createAccount({
      name: 'CCR 1',
      apiUrl: 'https://ccr.example.com',
      apiKey: 'secret',
      bridgeRoutingRules: inputRules
    })
    const key = `ccr_account:${created.id}`

    expect(hashes.get(key).bridgeRoutingRules).toBe(storedRules)
    expect(created.bridgeRoutingRules).toEqual(normalizedRules)

    await service.updateAccount(created.id, { bridgeRoutingRules: inputRules })

    expect(hashes.get(key).bridgeRoutingRules).toBe(storedRules)
    await expect(service.getAccount(created.id)).resolves.toMatchObject({
      bridgeRoutingRules: normalizedRules
    })
    hashes.set('ccr_account:ccr-1', hashes.get(key))
    await expect(service.getAllAccounts()).resolves.toEqual([
      expect.objectContaining({
        bridgeRoutingRules: normalizedRules
      })
    ])
  })
})
