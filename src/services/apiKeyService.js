const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const config = require('../../config/config')
const redis = require('../models/redis')
const logger = require('../utils/logger')

class ApiKeyService {
  constructor() {
    this.prefix = config.security.apiKeyPrefix
  }

  // 🔑 生成新的API Key
  async generateApiKey(options = {}) {
    const {
      name = 'Unnamed Key',
      description = '',
      tokenLimit = config.limits.defaultTokenLimit,
      expiresAt = null,
      claudeAccountId = null,
      claudeConsoleAccountId = null,
      geminiAccountId = null,
      openaiAccountId = null,
      permissions = 'all', // 'claude', 'gemini', 'openai', 'all'
      isActive = true,
      concurrencyLimit = 0,
      rateLimitWindow = null,
      rateLimitRequests = null,
      enableModelRestriction = false,
      restrictedModels = [],
      enableClientRestriction = false,
      allowedClients = [],
      dailyCostLimit = 0,
      tags = []
    } = options

    // 生成简单的API Key (64字符十六进制)
    const apiKey = `${this.prefix}${this._generateSecretKey()}`
    const keyId = uuidv4()
    const hashedKey = this._hashApiKey(apiKey)

    const keyData = {
      id: keyId,
      name,
      description,
      apiKey: hashedKey,
      tokenLimit: String(tokenLimit ?? 0),
      concurrencyLimit: String(concurrencyLimit ?? 0),
      rateLimitWindow: String(rateLimitWindow ?? 0),
      rateLimitRequests: String(rateLimitRequests ?? 0),
      isActive: String(isActive),
      claudeAccountId: claudeAccountId || '',
      claudeConsoleAccountId: claudeConsoleAccountId || '',
      geminiAccountId: geminiAccountId || '',
      openaiAccountId: openaiAccountId || '',
      permissions: permissions || 'all',
      enableModelRestriction: String(enableModelRestriction),
      restrictedModels: JSON.stringify(restrictedModels || []),
      enableClientRestriction: String(enableClientRestriction || false),
      allowedClients: JSON.stringify(allowedClients || []),
      dailyCostLimit: String(dailyCostLimit || 0),
      tags: JSON.stringify(tags || []),
      createdAt: new Date().toISOString(),
      lastUsedAt: '',
      expiresAt: expiresAt || '',
      createdBy: options.createdBy || 'admin',
      userId: options.userId || '',
      userUsername: options.userUsername || ''
    }

    // 保存API Key数据并建立哈希映射
    await redis.setApiKey(keyId, keyData, hashedKey)

    logger.success(`🔑 Generated new API key: ${name} (${keyId})`)

    return {
      id: keyId,
      apiKey, // 只在创建时返回完整的key
      name: keyData.name,
      description: keyData.description,
      tokenLimit: parseInt(keyData.tokenLimit),
      concurrencyLimit: parseInt(keyData.concurrencyLimit),
      rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
      rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
      isActive: keyData.isActive === 'true',
      claudeAccountId: keyData.claudeAccountId,
      claudeConsoleAccountId: keyData.claudeConsoleAccountId,
      geminiAccountId: keyData.geminiAccountId,
      openaiAccountId: keyData.openaiAccountId,
      permissions: keyData.permissions,
      enableModelRestriction: keyData.enableModelRestriction === 'true',
      restrictedModels: JSON.parse(keyData.restrictedModels),
      enableClientRestriction: keyData.enableClientRestriction === 'true',
      allowedClients: JSON.parse(keyData.allowedClients || '[]'),
      dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
      tags: JSON.parse(keyData.tags || '[]'),
      createdAt: keyData.createdAt,
      expiresAt: keyData.expiresAt,
      createdBy: keyData.createdBy
    }
  }

  // 🔍 验证API Key
  async validateApiKey(apiKey) {
    try {
      if (!apiKey || !apiKey.startsWith(this.prefix)) {
        return { valid: false, error: 'Invalid API key format' }
      }

      // 计算API Key的哈希值
      const hashedKey = this._hashApiKey(apiKey)

      // 通过哈希值直接查找API Key（性能优化）
      const keyData = await redis.findApiKeyByHash(hashedKey)

      if (!keyData) {
        return { valid: false, error: 'API key not found' }
      }

      // 检查是否激活
      if (keyData.isActive !== 'true') {
        return { valid: false, error: 'API key is disabled' }
      }

      // 检查是否过期
      if (keyData.expiresAt && new Date() > new Date(keyData.expiresAt)) {
        return { valid: false, error: 'API key has expired' }
      }

      // 获取使用统计（供返回数据使用）
      const usage = await redis.getUsageStats(keyData.id)

      // 获取当日费用统计
      const dailyCost = await redis.getDailyCost(keyData.id)

      // 更新最后使用时间（优化：只在实际API调用时更新，而不是验证时）
      // 注意：lastUsedAt的更新已移至recordUsage方法中

      logger.api(`🔓 API key validated successfully: ${keyData.id}`)

      // 解析限制模型数据
      let restrictedModels = []
      try {
        restrictedModels = keyData.restrictedModels ? JSON.parse(keyData.restrictedModels) : []
      } catch (e) {
        restrictedModels = []
      }

      // 解析允许的客户端
      let allowedClients = []
      try {
        allowedClients = keyData.allowedClients ? JSON.parse(keyData.allowedClients) : []
      } catch (e) {
        allowedClients = []
      }

      // 解析标签
      let tags = []
      try {
        tags = keyData.tags ? JSON.parse(keyData.tags) : []
      } catch (e) {
        tags = []
      }

      return {
        valid: true,
        keyData: {
          id: keyData.id,
          name: keyData.name,
          description: keyData.description,
          createdAt: keyData.createdAt,
          expiresAt: keyData.expiresAt,
          claudeAccountId: keyData.claudeAccountId,
          claudeConsoleAccountId: keyData.claudeConsoleAccountId,
          geminiAccountId: keyData.geminiAccountId,
          openaiAccountId: keyData.openaiAccountId,
          permissions: keyData.permissions || 'all',
          tokenLimit: parseInt(keyData.tokenLimit),
          concurrencyLimit: parseInt(keyData.concurrencyLimit || 0),
          rateLimitWindow: parseInt(keyData.rateLimitWindow || 0),
          rateLimitRequests: parseInt(keyData.rateLimitRequests || 0),
          enableModelRestriction: keyData.enableModelRestriction === 'true',
          restrictedModels,
          enableClientRestriction: keyData.enableClientRestriction === 'true',
          allowedClients,
          dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
          dailyCost: dailyCost || 0,
          tags,
          usage
        }
      }
    } catch (error) {
      logger.error('❌ API key validation error:', error)
      return { valid: false, error: 'Internal validation error' }
    }
  }

  // 📋 获取所有API Keys
  async getAllApiKeys() {
    try {
      const apiKeys = await redis.getAllApiKeys()
      const client = redis.getClientSafe()

      // 为每个key添加使用统计和当前并发数
      for (const key of apiKeys) {
        key.usage = await redis.getUsageStats(key.id)
        key.tokenLimit = parseInt(key.tokenLimit)
        key.concurrencyLimit = parseInt(key.concurrencyLimit || 0)
        key.rateLimitWindow = parseInt(key.rateLimitWindow || 0)
        key.rateLimitRequests = parseInt(key.rateLimitRequests || 0)
        key.currentConcurrency = await redis.getConcurrency(key.id)
        key.isActive = key.isActive === 'true'
        key.enableModelRestriction = key.enableModelRestriction === 'true'
        key.enableClientRestriction = key.enableClientRestriction === 'true'
        key.permissions = key.permissions || 'all' // 兼容旧数据
        key.dailyCostLimit = parseFloat(key.dailyCostLimit || 0)
        key.dailyCost = (await redis.getDailyCost(key.id)) || 0

        // 获取当前时间窗口的请求次数和Token使用量
        if (key.rateLimitWindow > 0) {
          const requestCountKey = `rate_limit:requests:${key.id}`
          const tokenCountKey = `rate_limit:tokens:${key.id}`
          const windowStartKey = `rate_limit:window_start:${key.id}`

          key.currentWindowRequests = parseInt((await client.get(requestCountKey)) || '0')
          key.currentWindowTokens = parseInt((await client.get(tokenCountKey)) || '0')

          // 获取窗口开始时间和计算剩余时间
          const windowStart = await client.get(windowStartKey)
          if (windowStart) {
            const now = Date.now()
            const windowStartTime = parseInt(windowStart)
            const windowDuration = key.rateLimitWindow * 60 * 1000 // 转换为毫秒
            const windowEndTime = windowStartTime + windowDuration

            // 如果窗口还有效
            if (now < windowEndTime) {
              key.windowStartTime = windowStartTime
              key.windowEndTime = windowEndTime
              key.windowRemainingSeconds = Math.max(0, Math.floor((windowEndTime - now) / 1000))
            } else {
              // 窗口已过期，下次请求会重置
              key.windowStartTime = null
              key.windowEndTime = null
              key.windowRemainingSeconds = 0
              // 重置计数为0，因为窗口已过期
              key.currentWindowRequests = 0
              key.currentWindowTokens = 0
            }
          } else {
            // 窗口还未开始（没有任何请求）
            key.windowStartTime = null
            key.windowEndTime = null
            key.windowRemainingSeconds = null
          }
        } else {
          key.currentWindowRequests = 0
          key.currentWindowTokens = 0
          key.windowStartTime = null
          key.windowEndTime = null
          key.windowRemainingSeconds = null
        }

        try {
          key.restrictedModels = key.restrictedModels ? JSON.parse(key.restrictedModels) : []
        } catch (e) {
          key.restrictedModels = []
        }
        try {
          key.allowedClients = key.allowedClients ? JSON.parse(key.allowedClients) : []
        } catch (e) {
          key.allowedClients = []
        }
        try {
          key.tags = key.tags ? JSON.parse(key.tags) : []
        } catch (e) {
          key.tags = []
        }
        delete key.apiKey // 不返回哈希后的key
      }

      return apiKeys
    } catch (error) {
      logger.error('❌ Failed to get API keys:', error)
      throw error
    }
  }

  // 📝 更新API Key
  async updateApiKey(keyId, updates) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        throw new Error('API key not found')
      }

      // 允许更新的字段
      const allowedUpdates = [
        'name',
        'description',
        'tokenLimit',
        'concurrencyLimit',
        'rateLimitWindow',
        'rateLimitRequests',
        'isActive',
        'claudeAccountId',
        'claudeConsoleAccountId',
        'geminiAccountId',
        'openaiAccountId',
        'permissions',
        'expiresAt',
        'enableModelRestriction',
        'restrictedModels',
        'enableClientRestriction',
        'allowedClients',
        'dailyCostLimit',
        'tags'
      ]
      const updatedData = { ...keyData }

      for (const [field, value] of Object.entries(updates)) {
        if (allowedUpdates.includes(field)) {
          if (field === 'restrictedModels' || field === 'allowedClients' || field === 'tags') {
            // 特殊处理数组字段
            updatedData[field] = JSON.stringify(value || [])
          } else if (field === 'enableModelRestriction' || field === 'enableClientRestriction') {
            // 布尔值转字符串
            updatedData[field] = String(value)
          } else {
            updatedData[field] = (value !== null && value !== undefined ? value : '').toString()
          }
        }
      }

      updatedData.updatedAt = new Date().toISOString()

      // 更新时不需要重新建立哈希映射，因为API Key本身没有变化
      await redis.setApiKey(keyId, updatedData)

      logger.success(`📝 Updated API key: ${keyId}`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to update API key:', error)
      throw error
    }
  }

  // 🗑️ 删除API Key
  async deleteApiKey(keyId) {
    try {
      const result = await redis.deleteApiKey(keyId)

      if (result === 0) {
        throw new Error('API key not found')
      }

      logger.success(`🗑️ Deleted API key: ${keyId}`)

      return { success: true }
    } catch (error) {
      logger.error('❌ Failed to delete API key:', error)
      throw error
    }
  }

  // 📊 记录使用情况（支持缓存token和账户级别统计）
  async recordUsage(
    keyId,
    inputTokens = 0,
    outputTokens = 0,
    cacheCreateTokens = 0,
    cacheReadTokens = 0,
    model = 'unknown',
    accountId = null
  ) {
    try {
      const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

      // 计算费用
      const CostCalculator = require('../utils/costCalculator')
      const costInfo = CostCalculator.calculateCost(
        {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: cacheCreateTokens,
          cache_read_input_tokens: cacheReadTokens
        },
        model
      )

      // 记录API Key级别的使用统计
      await redis.incrementTokenUsage(
        keyId,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        model
      )

      // 记录费用统计
      if (costInfo.costs.total > 0) {
        await redis.incrementDailyCost(keyId, costInfo.costs.total)
        logger.database(
          `💰 Recorded cost for ${keyId}: $${costInfo.costs.total.toFixed(6)}, model: ${model}`
        )
      } else {
        logger.debug(`💰 No cost recorded for ${keyId} - zero cost for model: ${model}`)
      }

      // 获取API Key数据以确定关联的账户
      const keyData = await redis.getApiKey(keyId)
      if (keyData && Object.keys(keyData).length > 0) {
        // 更新最后使用时间
        keyData.lastUsedAt = new Date().toISOString()
        await redis.setApiKey(keyId, keyData)

        // 记录账户级别的使用统计（只统计实际处理请求的账户）
        if (accountId) {
          await redis.incrementAccountUsage(
            accountId,
            totalTokens,
            inputTokens,
            outputTokens,
            cacheCreateTokens,
            cacheReadTokens,
            model
          )
          logger.database(
            `📊 Recorded account usage: ${accountId} - ${totalTokens} tokens (API Key: ${keyId})`
          )
        } else {
          logger.debug(
            '⚠️ No accountId provided for usage recording, skipping account-level statistics'
          )
        }
      }

      const logParts = [`Model: ${model}`, `Input: ${inputTokens}`, `Output: ${outputTokens}`]
      if (cacheCreateTokens > 0) {
        logParts.push(`Cache Create: ${cacheCreateTokens}`)
      }
      if (cacheReadTokens > 0) {
        logParts.push(`Cache Read: ${cacheReadTokens}`)
      }
      logParts.push(`Total: ${totalTokens} tokens`)

      logger.database(`📊 Recorded usage: ${keyId} - ${logParts.join(', ')}`)
    } catch (error) {
      logger.error('❌ Failed to record usage:', error)
    }
  }

  // 🔐 生成密钥
  _generateSecretKey() {
    return crypto.randomBytes(32).toString('hex')
  }

  // 🔒 哈希API Key
  _hashApiKey(apiKey) {
    return crypto
      .createHash('sha256')
      .update(apiKey + config.security.encryptionKey)
      .digest('hex')
  }

  // 📈 获取使用统计
  async getUsageStats(keyId) {
    return await redis.getUsageStats(keyId)
  }

  // 📊 获取账户使用统计
  async getAccountUsageStats(accountId) {
    return await redis.getAccountUsageStats(accountId)
  }

  // 📈 获取所有账户使用统计
  async getAllAccountsUsageStats() {
    return await redis.getAllAccountsUsageStats()
  }

  // === 用户相关方法 ===

  // 🔑 创建API Key（支持用户）
  async createApiKey(options = {}) {
    return await this.generateApiKey(options)
  }

  // 👤 获取用户的API Keys
  async getUserApiKeys(userId) {
    try {
      const allKeys = await redis.getAllApiKeys()
      const userKeys = allKeys.filter((key) => key.userId === userId)

      // Populate usage stats for each user's API key (same as getAllApiKeys does)
      const userKeysWithUsage = []
      for (const key of userKeys) {
        const usage = await redis.getUsageStats(key.id)
        const dailyCost = (await redis.getDailyCost(key.id)) || 0

        userKeysWithUsage.push({
          id: key.id,
          name: key.name,
          description: key.description,
          key: key.apiKey ? `${this.prefix}****${key.apiKey.slice(-4)}` : null, // 只显示前缀和后4位
          tokenLimit: parseInt(key.tokenLimit || 0),
          isActive: key.isActive === 'true',
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
          expiresAt: key.expiresAt,
          usage: usage || { requests: 0, inputTokens: 0, outputTokens: 0, totalCost: 0 },
          dailyCost,
          dailyCostLimit: parseFloat(key.dailyCostLimit || 0),
          userId: key.userId,
          userUsername: key.userUsername,
          createdBy: key.createdBy
        })
      }

      return userKeysWithUsage
    } catch (error) {
      logger.error('❌ Failed to get user API keys:', error)
      return []
    }
  }

  // 🔍 通过ID获取API Key（检查权限）
  async getApiKeyById(keyId, userId = null) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData) {
        return null
      }

      // 如果指定了用户ID，检查权限
      if (userId && keyData.userId !== userId) {
        return null
      }

      return {
        id: keyData.id,
        name: keyData.name,
        description: keyData.description,
        key: keyData.apiKey,
        tokenLimit: parseInt(keyData.tokenLimit || 0),
        isActive: keyData.isActive === 'true',
        createdAt: keyData.createdAt,
        lastUsedAt: keyData.lastUsedAt,
        expiresAt: keyData.expiresAt,
        userId: keyData.userId,
        userUsername: keyData.userUsername,
        createdBy: keyData.createdBy,
        permissions: keyData.permissions,
        dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0)
      }
    } catch (error) {
      logger.error('❌ Failed to get API key by ID:', error)
      return null
    }
  }

  // 🔄 重新生成API Key
  async regenerateApiKey(keyId) {
    try {
      const existingKey = await redis.getApiKey(keyId)
      if (!existingKey) {
        throw new Error('API key not found')
      }

      // 生成新的key
      const newApiKey = `${this.prefix}${this._generateSecretKey()}`
      const newHashedKey = this._hashApiKey(newApiKey)

      // 删除旧的哈希映射
      const oldHashedKey = existingKey.apiKey
      await redis.deleteApiKeyHash(oldHashedKey)

      // 更新key数据
      const updatedKeyData = {
        ...existingKey,
        apiKey: newHashedKey,
        updatedAt: new Date().toISOString()
      }

      // 保存新数据并建立新的哈希映射
      await redis.setApiKey(keyId, updatedKeyData, newHashedKey)

      logger.info(`🔄 Regenerated API key: ${existingKey.name} (${keyId})`)

      return {
        id: keyId,
        name: existingKey.name,
        key: newApiKey, // 返回完整的新key
        updatedAt: updatedKeyData.updatedAt
      }
    } catch (error) {
      logger.error('❌ Failed to regenerate API key:', error)
      throw error
    }
  }

  // 🗑️ 删除API Key
  async deleteApiKey(keyId) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData) {
        throw new Error('API key not found')
      }

      // 删除key数据和哈希映射
      await redis.deleteApiKey(keyId)
      await redis.deleteApiKeyHash(keyData.apiKey)

      logger.info(`🗑️ Deleted API key: ${keyData.name} (${keyId})`)
      return true
    } catch (error) {
      logger.error('❌ Failed to delete API key:', error)
      throw error
    }
  }

  // 🚫 禁用用户的所有API Keys
  async disableUserApiKeys(userId) {
    try {
      const userKeys = await this.getUserApiKeys(userId)
      let disabledCount = 0

      for (const key of userKeys) {
        if (key.isActive) {
          await this.updateApiKey(key.id, { isActive: false })
          disabledCount++
        }
      }

      logger.info(`🚫 Disabled ${disabledCount} API keys for user: ${userId}`)
      return { count: disabledCount }
    } catch (error) {
      logger.error('❌ Failed to disable user API keys:', error)
      throw error
    }
  }

  // 📊 获取使用统计（支持多个API Key）
  async getUsageStats(keyIds, options = {}) {
    try {
      if (!Array.isArray(keyIds)) {
        keyIds = [keyIds]
      }

      const { period = 'week', model } = options
      const stats = {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        dailyStats: [],
        modelStats: []
      }

      // 汇总所有API Key的统计数据
      for (const keyId of keyIds) {
        const keyStats = await redis.getUsageStats(keyId)
        if (keyStats) {
          stats.totalRequests += keyStats.requests || 0
          stats.totalInputTokens += keyStats.inputTokens || 0
          stats.totalOutputTokens += keyStats.outputTokens || 0
          stats.totalCost += keyStats.totalCost || 0
        }
      }

      // TODO: 实现日期范围和模型统计
      // 这里可以根据需要添加更详细的统计逻辑

      return stats
    } catch (error) {
      logger.error('❌ Failed to get usage stats:', error)
      return {
        totalRequests: 0,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCost: 0,
        dailyStats: [],
        modelStats: []
      }
    }
  }

  // 🧹 清理过期的API Keys
  async cleanupExpiredKeys() {
    try {
      const apiKeys = await redis.getAllApiKeys()
      const now = new Date()
      let cleanedCount = 0

      for (const key of apiKeys) {
        // 检查是否已过期且仍处于激活状态
        if (key.expiresAt && new Date(key.expiresAt) < now && key.isActive === 'true') {
          // 将过期的 API Key 标记为禁用状态，而不是直接删除
          await this.updateApiKey(key.id, { isActive: false })
          logger.info(`🔒 API Key ${key.id} (${key.name}) has expired and been disabled`)
          cleanedCount++
        }
      }

      if (cleanedCount > 0) {
        logger.success(`🧹 Disabled ${cleanedCount} expired API keys`)
      }

      return cleanedCount
    } catch (error) {
      logger.error('❌ Failed to cleanup expired keys:', error)
      return 0
    }
  }
}

// 导出实例和单独的方法
const apiKeyService = new ApiKeyService()

// 为了方便其他服务调用，导出 recordUsage 方法
apiKeyService.recordUsageMetrics = apiKeyService.recordUsage.bind(apiKeyService)

module.exports = apiKeyService
