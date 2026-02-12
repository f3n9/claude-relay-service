const { v4: uuidv4 } = require('uuid')
const crypto = require('crypto')
const { GoogleAuth } = require('google-auth-library')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const config = require('../../../config/config')
const LRUCache = require('../../utils/lruCache')
const ProxyHelper = require('../../utils/proxyHelper')
const { createEncryptor } = require('../../utils/commonHelper')

class GcpVertexAccountService {
  constructor() {
    this.ACCOUNT_KEY_PREFIX = 'claude_vertex_account:'

    // 使用通用加密器（独立 salt）
    const encryptor = createEncryptor('claude-vertex-salt')
    this._encrypt = encryptor.encrypt
    this._decrypt = encryptor.decrypt

    this._authClientCache = new LRUCache(200)
  }

  _parseServiceAccountJson(serviceAccountJson) {
    const raw =
      typeof serviceAccountJson === 'string'
        ? serviceAccountJson.trim()
        : JSON.stringify(serviceAccountJson || {})

    if (!raw) {
      throw new Error('Service account JSON is required')
    }

    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      throw new Error('Invalid service account JSON')
    }

    const requiredFields = ['project_id', 'private_key', 'client_email']
    const missing = requiredFields.filter((field) => !parsed[field])
    if (missing.length > 0) {
      throw new Error(`Service account JSON missing fields: ${missing.join(', ')}`)
    }

    return { raw, parsed }
  }

  _getAuthCacheKey(account) {
    let proxyKey = ''
    if (account.proxy) {
      if (typeof account.proxy === 'string') {
        proxyKey = account.proxy
      } else {
        try {
          proxyKey = JSON.stringify(account.proxy)
        } catch {
          proxyKey = String(account.proxy)
        }
      }
    }
    const basis = `${account.id}:${account.serviceAccountJson || ''}:${proxyKey}`
    return crypto.createHash('sha256').update(basis).digest('hex')
  }

  async _getAuthClient(account) {
    const cacheKey = this._getAuthCacheKey(account)
    const cached = this._authClientCache.get(cacheKey)
    if (cached) {
      return cached
    }

    const serviceAccountJson = this._decrypt(account.serviceAccountJson)
    const credentials = JSON.parse(serviceAccountJson)
    const scope = 'https://www.googleapis.com/auth/cloud-platform'

    const proxyAgent = account.proxy ? ProxyHelper.createProxyAgent(account.proxy) : null
    const clientOptions = proxyAgent ? { transporterOptions: { agent: proxyAgent } } : {}

    const auth = new GoogleAuth({
      credentials,
      scopes: [scope],
      clientOptions
    })

    const client = await auth.getClient()
    this._authClientCache.set(cacheKey, client, 50 * 60 * 1000)
    return client
  }

  async getAccessToken(account) {
    const client = await this._getAuthClient(account)
    const token = await client.getAccessToken()
    return token?.token || token
  }

  async createAccount(options = {}) {
    const {
      name = 'GCP Vertex Claude Account',
      description = '',
      serviceAccountJson = null,
      projectId = null,
      location = config.gcpVertex?.defaultLocation || 'global',
      defaultModel = config.gcpVertex?.defaultModel || '',
      anthropicVersion = config.gcpVertex?.anthropicVersion || 'vertex-2023-10-16',
      isActive = true,
      accountType = 'shared',
      priority = 50,
      schedulable = true,
      rateLimitDuration = 60,
      proxy = null
    } = options

    const { raw, parsed } = this._parseServiceAccountJson(serviceAccountJson)

    const accountId = uuidv4()
    const now = new Date().toISOString()

    const accountData = {
      id: accountId,
      name,
      description,
      projectId: projectId || parsed.project_id,
      location,
      defaultModel,
      anthropicVersion,
      serviceAccountJson: this._encrypt(raw),
      clientEmail: parsed.client_email,
      isActive: isActive === true,
      accountType,
      priority,
      schedulable: schedulable === true,
      rateLimitDuration,
      rateLimitedAt: '',
      rateLimitStatus: '',
      rateLimitAutoStopped: '',
      proxy: proxy ? JSON.stringify(proxy) : '',
      status: 'active',
      createdAt: now,
      updatedAt: now
    }

    const client = redis.getClientSafe()
    await client.set(`${this.ACCOUNT_KEY_PREFIX}${accountId}`, JSON.stringify(accountData))
    await redis.addToIndex('claude_vertex_account:index', accountId)

    logger.info(`✅ 创建 GCP Vertex Claude 账户成功 - ${name} (${accountId})`)

    return {
      success: true,
      data: this._toSafeAccountSummary(accountData)
    }
  }

  _toSafeAccountSummary(accountData) {
    return {
      id: accountData.id,
      name: accountData.name,
      description: accountData.description,
      projectId: accountData.projectId,
      location: accountData.location,
      defaultModel: accountData.defaultModel,
      anthropicVersion: accountData.anthropicVersion,
      isActive: accountData.isActive === true,
      accountType: accountData.accountType,
      priority: accountData.priority,
      schedulable: accountData.schedulable !== false,
      rateLimitDuration:
        accountData.rateLimitDuration !== undefined && accountData.rateLimitDuration !== null
          ? accountData.rateLimitDuration
          : 60,
      rateLimitStatus: accountData.rateLimitStatus || '',
      rateLimitedAt: accountData.rateLimitedAt || '',
      rateLimitAutoStopped: accountData.rateLimitAutoStopped || '',
      createdAt: accountData.createdAt,
      updatedAt: accountData.updatedAt,
      proxy: accountData.proxy ? JSON.parse(accountData.proxy) : null,
      status: accountData.status || 'active',
      platform: 'claude-vertex',
      hasCredentials: !!accountData.serviceAccountJson
    }
  }

  async getAccount(accountId) {
    try {
      const client = redis.getClientSafe()
      const accountData = await client.get(`${this.ACCOUNT_KEY_PREFIX}${accountId}`)
      if (!accountData) {
        return null
      }
      const account = JSON.parse(accountData)

      if (account.serviceAccountJson) {
        account.serviceAccountJson = this._decrypt(account.serviceAccountJson)
      }
      if (account.proxy) {
        account.proxy = JSON.parse(account.proxy)
      }

      return account
    } catch (error) {
      logger.error(`❌ Failed to get GCP Vertex account ${accountId}:`, error)
      return null
    }
  }

  async getAllAccounts() {
    try {
      const accountIds = await redis.getAllIdsByIndex(
        'claude_vertex_account:index',
        `${this.ACCOUNT_KEY_PREFIX}*`,
        /^claude_vertex_account:(.+)$/
      )
      const keys = accountIds.map((id) => `${this.ACCOUNT_KEY_PREFIX}${id}`)
      const dataList = await redis.batchGetChunked(keys)
      const accounts = []

      for (let i = 0; i < keys.length; i++) {
        const raw = dataList[i]
        if (!raw) {
          continue
        }
        const account = JSON.parse(raw)
        accounts.push(this._toSafeAccountSummary(account))
      }

      accounts.sort((a, b) => {
        if (a.priority !== b.priority) {
          return a.priority - b.priority
        }
        return (a.name || '').localeCompare(b.name || '')
      })

      return { success: true, data: accounts }
    } catch (error) {
      logger.error('❌ Failed to list GCP Vertex accounts:', error)
      return { success: false, error: error.message }
    }
  }

  async updateAccount(accountId, updates = {}) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
    const existingRaw = await client.get(key)
    if (!existingRaw) {
      return { success: false, error: 'Account not found' }
    }

    const existing = JSON.parse(existingRaw)
    const next = { ...existing }

    if (updates.name !== undefined) {
      next.name = updates.name
    }
    if (updates.description !== undefined) {
      next.description = updates.description
    }
    if (updates.projectId !== undefined) {
      next.projectId = updates.projectId
    }
    if (updates.location !== undefined) {
      next.location = updates.location
    }
    if (updates.defaultModel !== undefined) {
      next.defaultModel = updates.defaultModel
    }
    if (updates.anthropicVersion !== undefined) {
      next.anthropicVersion = updates.anthropicVersion
    }
    if (updates.isActive !== undefined) {
      next.isActive = updates.isActive === true
    }
    if (updates.accountType !== undefined) {
      next.accountType = updates.accountType
    }
    if (updates.priority !== undefined) {
      next.priority = updates.priority
    }
    if (updates.schedulable !== undefined) {
      next.schedulable = updates.schedulable === true
    }
    if (updates.rateLimitDuration !== undefined) {
      next.rateLimitDuration = updates.rateLimitDuration
    }
    if (updates.proxy !== undefined) {
      next.proxy = updates.proxy ? JSON.stringify(updates.proxy) : ''
    }

    if (updates.serviceAccountJson !== undefined && updates.serviceAccountJson !== null) {
      const { raw, parsed } = this._parseServiceAccountJson(updates.serviceAccountJson)
      next.serviceAccountJson = this._encrypt(raw)
      next.clientEmail = parsed.client_email
      if (!next.projectId) {
        next.projectId = parsed.project_id
      }
      this._authClientCache.clear()
    }

    next.updatedAt = new Date().toISOString()

    await client.set(key, JSON.stringify(next))
    return { success: true, data: this._toSafeAccountSummary(next) }
  }

  async deleteAccount(accountId) {
    const client = redis.getClientSafe()
    await client.del(`${this.ACCOUNT_KEY_PREFIX}${accountId}`)
    await redis.removeFromIndex('claude_vertex_account:index', accountId)
    return { success: true }
  }

  async toggleSchedulable(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return { success: false, error: 'Account not found' }
    }
    const next = await this.updateAccount(accountId, { schedulable: !account.schedulable })
    return next
  }

  async resetAccountStatus(accountId) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
    const existingRaw = await client.get(key)
    if (!existingRaw) {
      return { success: false, error: 'Account not found' }
    }
    const account = JSON.parse(existingRaw)
    const updates = {
      status: 'active',
      rateLimitedAt: '',
      rateLimitStatus: '',
      rateLimitAutoStopped: ''
    }
    const next = { ...account, ...updates, updatedAt: new Date().toISOString() }
    await client.set(key, JSON.stringify(next))
    return { success: true, data: this._toSafeAccountSummary(next) }
  }

  async markAccountRateLimited(accountId) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
    const existingRaw = await client.get(key)
    if (!existingRaw) {
      return { success: false, error: 'Account not found' }
    }
    const account = JSON.parse(existingRaw)
    if (account.rateLimitDuration === 0) {
      return { success: true, skipped: true }
    }

    const now = new Date().toISOString()
    const next = {
      ...account,
      rateLimitedAt: now,
      rateLimitStatus: 'limited',
      rateLimitAutoStopped: 'true',
      updatedAt: now
    }
    await client.set(key, JSON.stringify(next))
    return { success: true }
  }

  async removeAccountRateLimit(accountId) {
    const client = redis.getClientSafe()
    const key = `${this.ACCOUNT_KEY_PREFIX}${accountId}`
    const existingRaw = await client.get(key)
    if (!existingRaw) {
      return { success: false, error: 'Account not found' }
    }
    const account = JSON.parse(existingRaw)
    const next = {
      ...account,
      rateLimitedAt: '',
      rateLimitStatus: '',
      rateLimitAutoStopped: '',
      updatedAt: new Date().toISOString()
    }
    await client.set(key, JSON.stringify(next))
    return { success: true }
  }

  async isAccountRateLimited(accountId) {
    const account = await this.getAccount(accountId)
    if (!account) {
      return false
    }
    if (account.rateLimitDuration === 0) {
      return false
    }
    if (account.rateLimitStatus !== 'limited' || !account.rateLimitedAt) {
      return false
    }

    const rateLimitedAt = new Date(account.rateLimitedAt)
    const minutesSince = (Date.now() - rateLimitedAt.getTime()) / (1000 * 60)
    const duration = Number.isFinite(Number(account.rateLimitDuration))
      ? Number(account.rateLimitDuration)
      : 60

    if (minutesSince >= duration) {
      await this.removeAccountRateLimit(accountId)
      return false
    }
    return true
  }
}

module.exports = new GcpVertexAccountService()
