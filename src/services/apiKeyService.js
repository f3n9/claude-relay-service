const crypto = require('crypto')
const { v4: uuidv4 } = require('uuid')
const config = require('../../config/config')
const redis = require('../models/redis')
const logger = require('../utils/logger')
const { DistributedLock } = require('../utils/distributedLock')

// 🔄 Data migration utilities for um-5 → dev compatibility
const DataMigrationUtils = {
  // Transform legacy um-5 data (userId/userUsername) to dev format (owner/ownerType)
  async normalizeApiKeyData(keyData, context = {}) {
    if (!keyData) {
      return keyData
    }

    // 🔒 Handle legacy userId/userUsername → owner/ownerType migration WITH authorization checks
    if (keyData.userId && !keyData.owner) {
      // 🔒 SECURITY: Validate the legacy migration is authorized
      const migrationResult = await this._validateLegacyMigration(keyData, context)

      if (!migrationResult.authorized) {
        logger.security(
          `🚨 Unauthorized data migration blocked for key ${keyData.id}: ${migrationResult.reason}`
        )

        // 记录安全事件
        const { securityAudit } = require('../utils/securityAudit')
        securityAudit.logSecurityEvent('DATA_MIGRATION', 'BLOCKED', {
          keyId: keyData.id,
          userId: keyData.userId,
          reason: migrationResult.reason,
          context: context.source || 'unknown',
          timestamp: new Date().toISOString()
        })

        throw new Error('Data migration authorization failed - potential security risk detected')
      }

      // 执行授权的迁移
      const originalOwner = keyData.owner
      keyData.owner = keyData.userUsername || keyData.userId
      keyData.ownerType = 'user'

      // 🔒 SECURITY: Log successful migration for audit trail
      logger.security(
        `🔄 Authorized legacy migration for key ${keyData.id}: userId(${keyData.userId}) → owner(${keyData.owner})`
      )

      const { securityAudit } = require('../utils/securityAudit')
      securityAudit.logSecurityEvent('DATA_MIGRATION', 'SUCCESS', {
        keyId: keyData.id,
        fromUserId: keyData.userId,
        toOwner: keyData.owner,
        previousOwner: originalOwner,
        context: context.source || 'api_validation',
        timestamp: new Date().toISOString()
      })
    }

    // Handle legacy createdBy values
    if (keyData.createdBy === 'user' && !keyData.ownerType) {
      keyData.ownerType = 'user'
    }

    return keyData
  },

  // 🔒 SECURITY: Validate that legacy data migration is authorized
  async _validateLegacyMigration(keyData, context = {}) {
    try {
      // 基本验证：必须有userId才能迁移
      if (!keyData.userId) {
        return { authorized: false, reason: 'No userId provided for migration' }
      }

      // 检查userId格式的合理性（基本反滥用检查）
      if (
        typeof keyData.userId !== 'string' ||
        keyData.userId.length > 100 ||
        keyData.userId.length < 1
      ) {
        return { authorized: false, reason: 'Invalid userId format or length' }
      }

      // 检查是否包含可疑字符（注入检查）
      const suspiciousPatterns = [
        /[<>"';&|`$(){}[\]]/, // 脚本注入字符
        /\.\./, // 路径遍历
        /\/\//, // URL schemes
        /^(admin|root|system)$/i // 特权用户名
      ]

      for (const pattern of suspiciousPatterns) {
        if (pattern.test(keyData.userId)) {
          return { authorized: false, reason: 'Suspicious characters in userId' }
        }
      }

      // 检查userUsername与userId的一致性（如果都存在）
      if (keyData.userUsername && keyData.userId !== keyData.userUsername) {
        // 允许合理的差异，但记录以备审计
        logger.debug(
          `Username mismatch in migration: userId=${keyData.userId}, userUsername=${keyData.userUsername}`
        )
      }

      // 🔒 频率限制：防止批量滥用迁移
      if (context.source === 'bulk_operation') {
        // 对于批量操作，需要额外的验证
        logger.security(`🔍 Bulk migration detected for userId: ${keyData.userId}`)
      }

      // 检查是否尝试重复迁移（可能的攻击指标）
      if (
        keyData.owner &&
        keyData.owner !== keyData.userId &&
        keyData.owner !== keyData.userUsername
      ) {
        return {
          authorized: false,
          reason: 'Key already has different owner - potential migration abuse'
        }
      }

      return { authorized: true, reason: 'Migration validation passed' }
    } catch (error) {
      logger.error(`Legacy migration validation error: ${error.message}`)
      return { authorized: false, reason: 'Validation service error - failing securely' }
    }
  },

  // Check if this is legacy um-5 data
  isLegacyData(keyData) {
    return keyData && (keyData.userId || keyData.userUsername) && !keyData.owner
  },

  // Validate legacy user data (backward compatibility)
  async validateLegacyUser(keyData) {
    if (!keyData.userId) {
      return { valid: true }
    }

    try {
      // Try to load userService if it exists (for backward compatibility)
      const userService = require('./userService')
      const user = await userService.getUserById(keyData.userId, false)
      if (!user || !user.isActive) {
        return { valid: false, error: 'User account is disabled' }
      }
      return { valid: true }
    } catch (error) {
      // SECURITY: Fail secure - if userService is unavailable, validation fails
      // This prevents authentication bypass when userService is compromised/unavailable
      logger.security(`🚨 Legacy user validation failed for ${keyData.userId}: ${error.message}`)
      return {
        valid: false,
        error: 'User validation service unavailable - security policy requires explicit validation'
      }
    }
  }
}

class ApiKeyService {
  constructor() {
    this.prefix = config.security.apiKeyPrefix

    // 🔒 DoS Protection: Rate limiting for failed hash lookups
    this.failedLookupCounter = new Map() // IP/source -> count
    this.circuitBreaker = {
      failureCount: 0,
      lastFailureTime: 0,
      isOpen: false,
      threshold: 10, // Open circuit after 10 failures
      timeout: 60000, // 1 minute timeout
      maxFullScanAttempts: 5 // Maximum full scans per minute
    }

    // 🔒 Race Condition Protection: Distributed lock for hash migration
    this.distributedLock = new DistributedLock(redis.client)
  }

  // 🔒 DoS Protection: Circuit breaker for full key scans
  _isCircuitBreakerOpen() {
    const now = Date.now()

    // Reset circuit breaker if timeout period has passed
    if (
      this.circuitBreaker.isOpen &&
      now - this.circuitBreaker.lastFailureTime > this.circuitBreaker.timeout
    ) {
      this.circuitBreaker.isOpen = false
      this.circuitBreaker.failureCount = 0
      logger.info('🔄 Circuit breaker reset - allowing hash verification attempts')
    }

    return this.circuitBreaker.isOpen
  }

  // 🔒 DoS Protection: Rate limiting for failed lookups by source
  _shouldAllowFullScan(sourceKey = 'global') {
    const now = Date.now()
    const windowStart = now - 60000 // 1 minute window

    // Clean old entries
    for (const [key, timestamps] of this.failedLookupCounter.entries()) {
      const validTimestamps = timestamps.filter((ts) => ts > windowStart)
      if (validTimestamps.length === 0) {
        this.failedLookupCounter.delete(key)
      } else {
        this.failedLookupCounter.set(key, validTimestamps)
      }
    }

    // Check rate limit for this source
    const attempts = this.failedLookupCounter.get(sourceKey) || []
    const recentAttempts = attempts.filter((ts) => ts > windowStart)

    if (recentAttempts.length >= this.circuitBreaker.maxFullScanAttempts) {
      logger.security(`🚨 Rate limit exceeded for full API key scan from source: ${sourceKey}`)
      return false
    }

    return true
  }

  // 🔒 DoS Protection: Record failed lookup attempt
  _recordFailedLookup(sourceKey = 'global') {
    const now = Date.now()
    const attempts = this.failedLookupCounter.get(sourceKey) || []
    attempts.push(now)
    this.failedLookupCounter.set(sourceKey, attempts)

    // Update circuit breaker
    this.circuitBreaker.failureCount++
    this.circuitBreaker.lastFailureTime = now

    if (this.circuitBreaker.failureCount >= this.circuitBreaker.threshold) {
      this.circuitBreaker.isOpen = true
      logger.security(
        `🚨 Circuit breaker opened - too many failed API key lookups (${this.circuitBreaker.failureCount})`
      )
    }
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
      azureOpenaiAccountId = null,
      bedrockAccountId = null, // 添加 Bedrock 账号ID支持
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
      tags = [],
      owner = null,
      ownerType = null
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
      azureOpenaiAccountId: azureOpenaiAccountId || '',
      bedrockAccountId: bedrockAccountId || '', // 添加 Bedrock 账号ID
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
      createdBy: 'admin', // 可以根据需要扩展用户系统
      owner: owner || '',
      ownerType: ownerType || ''
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
      azureOpenaiAccountId: keyData.azureOpenaiAccountId,
      bedrockAccountId: keyData.bedrockAccountId, // 添加 Bedrock 账号ID
      permissions: keyData.permissions,
      enableModelRestriction: keyData.enableModelRestriction === 'true',
      restrictedModels: JSON.parse(keyData.restrictedModels),
      enableClientRestriction: keyData.enableClientRestriction === 'true',
      allowedClients: JSON.parse(keyData.allowedClients || '[]'),
      dailyCostLimit: parseFloat(keyData.dailyCostLimit || 0),
      tags: JSON.parse(keyData.tags || '[]'),
      createdAt: keyData.createdAt,
      expiresAt: keyData.expiresAt,
      createdBy: keyData.createdBy,
      owner: keyData.owner,
      ownerType: keyData.ownerType
    }
  }

  // 🔍 验证API Key（安全增强版）
  async validateApiKey(apiKey) {
    try {
      if (!apiKey || !apiKey.startsWith(this.prefix)) {
        return { valid: false, error: 'Invalid API key format' }
      }

      // 🔒 使用增强的哈希方法计算API Key哈希
      const computedHash = this._hashApiKey(apiKey)

      // 🔍 通过哈希值查找API Key（支持多版本哈希）
      let keyData = await redis.findApiKeyByHash(computedHash)

      // 如果新版本哈希找不到，尝试使用旧版本哈希查找
      if (!keyData) {
        const legacyHash = crypto
          .createHash('sha256')
          .update(apiKey + config.security.encryptionKey)
          .digest('hex')

        keyData = await redis.findApiKeyByHash(legacyHash)

        if (keyData) {
          // 🔄 找到了使用旧哈希的API Key，触发异步迁移
          this._migrateApiKeyHash(keyData.id, apiKey, legacyHash)
          logger.info(`🔄 Legacy API key hash found, migration triggered: ${keyData.id}`)
        }
      }

      if (!keyData) {
        // 🔍 最后尝试通过所有已存储的API Key进行验证（处理版本不匹配的情况）
        // 🔒 DoS Protection: Check circuit breaker and rate limiting

        const sourceKey = 'api_key_verification' // Could be enhanced with IP-based tracking

        if (this._isCircuitBreakerOpen()) {
          logger.security('🚨 Circuit breaker is open - blocking full API key scan')
        } else if (!this._shouldAllowFullScan(sourceKey)) {
          logger.security('🚨 Rate limit exceeded for full API key scan')
          this._recordFailedLookup(sourceKey)
        } else {
          logger.info('🔍 Performing full API key scan - last resort verification')

          try {
            const allKeys = await redis.getAllApiKeys()

            // Additional protection: limit the number of keys to check
            const maxKeysToCheck = Math.min(allKeys.length, 1000) // Max 1000 keys per scan
            let checkedCount = 0

            for (const key of allKeys) {
              if (checkedCount >= maxKeysToCheck) {
                logger.security(`🚨 Full scan limited to ${maxKeysToCheck} keys for DoS protection`)
                break
              }

              if (this._verifyApiKeyHash(apiKey, key.apiKey)) {
                keyData = key
                logger.info(`🔍 API key found through hash verification: ${key.id}`)

                // 触发哈希迁移
                this._migrateApiKeyHash(key.id, apiKey, key.apiKey)
                break
              }
              checkedCount++
            }

            if (!keyData) {
              // Record failed lookup for DoS protection
              this._recordFailedLookup(sourceKey)
            }
          } catch (error) {
            logger.error(`Full API key scan failed: ${error.message}`)
            this._recordFailedLookup(sourceKey)
          }
        }
      }

      if (!keyData) {
        // 🔒 记录可疑的API Key验证尝试
        const hashedAttempt = crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16)
        logger.security(`🚨 Unknown API key validation attempt: ${hashedAttempt}...`)

        const { securityAudit } = require('../utils/securityAudit')
        securityAudit.logAuthentication('API_KEY_AUTH', 'FAILURE', null, {
          reason: 'api_key_not_found',
          hashedKey: hashedAttempt
        })

        return { valid: false, error: 'API key not found' }
      }

      // 🔄 Apply backward compatibility migration for existing um-5 data
      try {
        keyData = await DataMigrationUtils.normalizeApiKeyData(keyData, {
          source: 'api_validation'
        })
      } catch (migrationError) {
        logger.security(
          `🚨 Data migration failed for key ${keyData?.id || 'unknown'}: ${migrationError.message}`
        )
        return { valid: false, error: 'Data migration security check failed' }
      }

      // 🔍 Validate legacy user data if present (backward compatibility)
      if (DataMigrationUtils.isLegacyData(keyData)) {
        const legacyUserValidation = await DataMigrationUtils.validateLegacyUser(keyData)
        if (!legacyUserValidation.valid) {
          return legacyUserValidation
        }
        logger.info(
          `🔄 Using legacy API key for user ${keyData.owner} (migrated from userId: ${keyData.userId})`
        )
      }

      // 检查是否激活
      if (keyData.isActive !== 'true') {
        logger.security(`🔒 Disabled API key validation attempt: ${keyData.id}`)
        return { valid: false, error: 'API key is disabled' }
      }

      // 检查是否过期
      if (keyData.expiresAt && new Date() > new Date(keyData.expiresAt)) {
        logger.security(`🔒 Expired API key validation attempt: ${keyData.id}`)
        return { valid: false, error: 'API key has expired' }
      }

      // 获取使用统计（供返回数据使用）
      const usage = await redis.getUsageStats(keyData.id)

      // 获取当日费用统计
      const dailyCost = await redis.getDailyCost(keyData.id)

      // 🔒 记录成功的API Key验证
      logger.api(`🔓 API key validated successfully: ${keyData.id}`)

      const { securityAudit } = require('../utils/securityAudit')
      securityAudit.logAuthentication('API_KEY_AUTH', 'SUCCESS', null, {
        keyId: keyData.id,
        keyName: keyData.name
      })

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
          azureOpenaiAccountId: keyData.azureOpenaiAccountId,
          bedrockAccountId: keyData.bedrockAccountId, // 添加 Bedrock 账号ID
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

      const { securityAudit } = require('../utils/securityAudit')
      securityAudit.logAuthentication('API_KEY_AUTH', 'ERROR', null, {
        error: error.message,
        errorType: 'validation_error'
      })

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
        // 🔄 Apply backward compatibility migration to each key
        try {
          await DataMigrationUtils.normalizeApiKeyData(key, { source: 'bulk_listing' })
        } catch (migrationError) {
          logger.security(
            `🚨 Skipping key ${key?.id || 'unknown'} due to migration error: ${migrationError.message}`
          )
          continue // Skip this key if migration fails
        }
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
      logger.debug(`🔧 Updating API key ${keyId} with:`, updates)

      const keyData = await redis.getApiKey(keyId)
      if (!keyData || Object.keys(keyData).length === 0) {
        logger.error(`❌ API key not found: ${keyId}`)
        throw new Error('API key not found')
      }

      logger.debug(`📋 Current API key data:`, {
        id: keyData.id,
        name: keyData.name,
        owner: keyData.owner,
        ownerType: keyData.ownerType
      })

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
        'azureOpenaiAccountId',
        'bedrockAccountId', // 添加 Bedrock 账号ID
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

      logger.success(`📝 Updated API key: ${keyId}`, {
        updatedFields: Object.keys(updates),
        newName: updatedData.name
      })

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

  // 📊 记录使用情况（新版本，支持详细的缓存类型）
  async recordUsageWithDetails(keyId, usageObject, model = 'unknown', accountId = null) {
    try {
      // 提取 token 数量
      const inputTokens = usageObject.input_tokens || 0
      const outputTokens = usageObject.output_tokens || 0
      const cacheCreateTokens = usageObject.cache_creation_input_tokens || 0
      const cacheReadTokens = usageObject.cache_read_input_tokens || 0

      const totalTokens = inputTokens + outputTokens + cacheCreateTokens + cacheReadTokens

      // 计算费用（支持详细的缓存类型）- 添加错误处理
      let costInfo = { totalCost: 0, ephemeral5mCost: 0, ephemeral1hCost: 0 }
      try {
        const pricingService = require('./pricingService')
        // 确保 pricingService 已初始化
        if (!pricingService.pricingData) {
          logger.warn('⚠️ PricingService not initialized, initializing now...')
          await pricingService.initialize()
        }
        costInfo = pricingService.calculateCost(usageObject, model)
      } catch (pricingError) {
        logger.error('❌ Failed to calculate cost:', pricingError)
        // 继续执行，不要因为费用计算失败而跳过统计记录
      }

      // 提取详细的缓存创建数据
      let ephemeral5mTokens = 0
      let ephemeral1hTokens = 0

      if (usageObject.cache_creation && typeof usageObject.cache_creation === 'object') {
        ephemeral5mTokens = usageObject.cache_creation.ephemeral_5m_input_tokens || 0
        ephemeral1hTokens = usageObject.cache_creation.ephemeral_1h_input_tokens || 0
      }

      // 记录API Key级别的使用统计 - 这个必须执行
      await redis.incrementTokenUsage(
        keyId,
        totalTokens,
        inputTokens,
        outputTokens,
        cacheCreateTokens,
        cacheReadTokens,
        model,
        ephemeral5mTokens, // 传递5分钟缓存 tokens
        ephemeral1hTokens // 传递1小时缓存 tokens
      )

      // 记录费用统计
      if (costInfo.totalCost > 0) {
        await redis.incrementDailyCost(keyId, costInfo.totalCost)
        logger.database(
          `💰 Recorded cost for ${keyId}: $${costInfo.totalCost.toFixed(6)}, model: ${model}`
        )

        // 记录详细的缓存费用（如果有）
        if (costInfo.ephemeral5mCost > 0 || costInfo.ephemeral1hCost > 0) {
          logger.database(
            `💰 Cache costs - 5m: $${costInfo.ephemeral5mCost.toFixed(6)}, 1h: $${costInfo.ephemeral1hCost.toFixed(6)}`
          )
        }
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

        // 如果有详细的缓存创建数据，也记录它们
        if (usageObject.cache_creation) {
          const { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } =
            usageObject.cache_creation
          if (ephemeral_5m_input_tokens > 0) {
            logParts.push(`5m: ${ephemeral_5m_input_tokens}`)
          }
          if (ephemeral_1h_input_tokens > 0) {
            logParts.push(`1h: ${ephemeral_1h_input_tokens}`)
          }
        }
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

  // 🔒 哈希API Key（增强版 - 抗碰撞攻击）
  _hashApiKey(apiKey) {
    try {
      // 🔄 使用增强的哈希方法（v2）
      return this._hashApiKeyV2(apiKey)
    } catch (error) {
      logger.error('❌ V2 API Key hashing error:', error)
      // 回退到旧版本哈希（向后兼容）
      return this._hashApiKeyV1(apiKey)
    }
  }

  // 🔒 V2 API Key 哈希方法（使用PBKDF2增强安全性）
  _hashApiKeyV2(apiKey) {
    try {
      // 生成基于API Key的确定性盐（确保相同的API Key总是得到相同的哈希）
      const salt = crypto
        .createHash('sha256')
        .update(`${apiKey}v2_salt_${config.security.encryptionKey}`)
        .digest()

      // 使用PBKDF2进行密钥派生（10,000次迭代）
      const hash = crypto.pbkdf2Sync(apiKey, salt, 10000, 64, 'sha256')

      // 格式: v2:salt:hash
      const saltHex = salt.toString('hex')
      const hashHex = hash.toString('hex')
      const combinedHash = `v2:${saltHex}:${hashHex}`

      logger.debug('🔒 API Key hashed using V2 method (PBKDF2)')
      return combinedHash
    } catch (error) {
      logger.error('❌ V2 API Key hashing error:', error)
      throw error
    }
  }

  // 🔒 V1 API Key 哈希方法（原始方法 - 向后兼容）
  _hashApiKeyV1(apiKey) {
    try {
      const hash = crypto
        .createHash('sha256')
        .update(apiKey + config.security.encryptionKey)
        .digest('hex')

      // 为旧格式添加v1前缀以便识别
      return `v1:${hash}`
    } catch (error) {
      logger.error('❌ V1 API Key hashing error:', error)
      throw error
    }
  }

  // 🔍 验证API Key哈希（支持多版本）
  _verifyApiKeyHash(apiKey, storedHash) {
    try {
      // 🔍 检测哈希版本并使用对应的验证方法
      if (storedHash.startsWith('v2:')) {
        return this._verifyApiKeyHashV2(apiKey, storedHash)
      } else if (storedHash.startsWith('v1:')) {
        return this._verifyApiKeyHashV1(apiKey, storedHash)
      } else {
        // Legacy format (no version prefix)
        return this._verifyApiKeyHashLegacy(apiKey, storedHash)
      }
    } catch (error) {
      logger.error('❌ API Key hash verification error:', error)
      return false
    }
  }

  // 🔍 V2哈希验证
  _verifyApiKeyHashV2(apiKey, storedHash) {
    try {
      // 重新计算哈希并比较
      const computedHash = this._hashApiKeyV2(apiKey)

      // 使用时间常数比较防止时序攻击
      return this._secureCompare(computedHash, storedHash)
    } catch (error) {
      logger.error('❌ V2 hash verification error:', error)
      return false
    }
  }

  // 🔍 V1哈希验证
  _verifyApiKeyHashV1(apiKey, storedHash) {
    try {
      // 移除v1前缀
      const hashWithoutPrefix = storedHash.substring(3)
      const computedHash = crypto
        .createHash('sha256')
        .update(apiKey + config.security.encryptionKey)
        .digest('hex')

      return this._secureCompare(computedHash, hashWithoutPrefix)
    } catch (error) {
      logger.error('❌ V1 hash verification error:', error)
      return false
    }
  }

  // 🔍 Legacy哈希验证（原始格式）
  _verifyApiKeyHashLegacy(apiKey, storedHash) {
    try {
      const computedHash = crypto
        .createHash('sha256')
        .update(apiKey + config.security.encryptionKey)
        .digest('hex')

      return this._secureCompare(computedHash, storedHash)
    } catch (error) {
      logger.error('❌ Legacy hash verification error:', error)
      return false
    }
  }

  // 🔒 时间常数比较（防止时序攻击）
  _secureCompare(a, b) {
    if (a.length !== b.length) {
      return false
    }

    let result = 0
    for (let i = 0; i < a.length; i++) {
      result |= a.charCodeAt(i) ^ b.charCodeAt(i)
    }
    return result === 0
  }

  // 🔄 异步哈希迁移（在验证时升级旧哈希） - 使用分布式锁防止竞态条件
  async _migrateApiKeyHash(keyId, apiKey, currentHash) {
    // 🔒 使用分布式锁防止并发迁移导致的竞态条件
    const lockResource = `hash_migration:${keyId}`
    const lockTTL = 30000 // 30秒锁超时
    const maxRetries = 3
    const retryDelay = 1000

    try {
      // 只迁移旧版本的哈希
      if (currentHash.startsWith('v2:')) {
        return // 已经是最新版本
      }

      // 异步执行迁移以避免阻塞当前请求
      setImmediate(async () => {
        let lockAcquired = false

        try {
          // 🔒 获取分布式锁
          lockAcquired = await this.distributedLock.acquire(
            [lockResource],
            lockTTL,
            maxRetries,
            retryDelay,
            1 // 正常优先级
          )

          if (!lockAcquired) {
            logger.debug(`⏳ Hash migration for ${keyId} skipped - already in progress`)
            return
          }

          // 再次检查是否需要迁移（可能在等待锁期间已被其他进程迁移）
          const currentKeyData = await redis.getApiKey(keyId)
          if (!currentKeyData || Object.keys(currentKeyData).length === 0) {
            logger.debug(`⚠️  API key ${keyId} not found during migration`)
            return
          }

          if (currentKeyData.apiKey.startsWith('v2:')) {
            logger.debug(`✅ API key ${keyId} already migrated to V2`)
            return
          }

          // 生成新的V2哈希
          const newHash = this._hashApiKeyV2(apiKey)

          // 原子性地更新数据
          currentKeyData.apiKey = newHash
          await redis.setApiKey(keyId, currentKeyData, newHash)

          // 清理旧的哈希映射
          await redis.client.del(`api_key_hash:${currentHash}`)

          logger.info(`🔄 Successfully migrated API key hash to V2: ${keyId}`)
        } catch (migrationError) {
          logger.error(`❌ Hash migration failed for ${keyId}:`, migrationError)

          // 记录安全事件
          const { securityAudit } = require('../utils/securityAudit')
          securityAudit.logSecurityEvent('HASH_MIGRATION', 'ERROR', {
            keyId,
            error: migrationError.message,
            timestamp: new Date().toISOString()
          })
        } finally {
          // 🔓 释放分布式锁
          if (lockAcquired) {
            try {
              await this.distributedLock.release([lockResource])
            } catch (releaseError) {
              logger.error(`❌ Failed to release migration lock for ${keyId}:`, releaseError)
            }
          }
        }
      })
    } catch (error) {
      logger.debug('Hash migration preparation failed:', error.message)
    }
  }

  // 🕵️ 碰撞检测（检测潜在的哈希碰撞）
  async _detectHashCollisions() {
    try {
      const allKeys = await redis.getAllApiKeys()
      const hashCounts = new Map()
      const collisions = []

      // 统计每个哈希出现的次数
      for (const key of allKeys) {
        const hash = key.apiKey
        if (hashCounts.has(hash)) {
          hashCounts.set(hash, hashCounts.get(hash) + 1)
        } else {
          hashCounts.set(hash, 1)
        }
      }

      // 查找碰撞（同一个哈希对应多个密钥）
      for (const [hash, count] of hashCounts.entries()) {
        if (count > 1) {
          const keysWithSameHash = allKeys
            .filter((key) => key.apiKey === hash)
            .map((key) => ({ id: key.id, name: key.name }))

          collisions.push({
            hash: `${hash.substring(0, 16)}...`, // 只显示部分哈希用于日志
            count,
            keys: keysWithSameHash
          })
        }
      }

      if (collisions.length > 0) {
        logger.error(`🚨 Hash collisions detected: ${collisions.length} cases`, collisions)

        // 发送安全告警
        const { securityAudit } = require('../utils/securityAudit')
        securityAudit.logSecurityViolation(
          'HASH_COLLISION',
          'API Key hash collision detected',
          'LOGGED',
          null,
          { collisionCount: collisions.length, details: collisions }
        )
      }

      return collisions
    } catch (error) {
      logger.error('❌ Hash collision detection error:', error)
      return []
    }
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

  // 🔄 Legacy Methods for Backward Compatibility (um-5 → dev transition)

  // 👤 Get API Keys by user (legacy compatibility method)
  async getUserApiKeys(userId, includeDeleted = false) {
    try {
      const allKeys = await this.getAllApiKeys()
      // Support both legacy userId and new owner formats
      let userKeys = allKeys.filter(
        (key) => key.userId === userId || (key.owner === userId && key.ownerType === 'user')
      )

      if (!includeDeleted) {
        userKeys = userKeys.filter((key) => !key.isDeleted || key.isDeleted !== 'true')
      }

      // Transform to include both old and new formats for compatibility
      return userKeys.map((key) => ({
        ...key,
        // Preserve legacy fields for existing integrations
        userId: key.userId || (key.ownerType === 'user' ? key.owner : ''),
        userUsername: key.userUsername || (key.ownerType === 'user' ? key.owner : ''),
        owner: key.owner,
        ownerType: key.ownerType
      }))
    } catch (error) {
      logger.error('❌ Failed to get user API keys:', error)
      throw error
    }
  }

  // 🔍 Get API Key by ID with user permission check (legacy compatibility)
  async getApiKeyById(keyId, userId = null) {
    try {
      const keyData = await redis.getApiKey(keyId)
      if (!keyData) {
        return null
      }

      // Apply migration with security checks
      try {
        await DataMigrationUtils.normalizeApiKeyData(keyData, { source: 'individual_lookup' })
      } catch (migrationError) {
        logger.security(`🚨 Data migration failed for key ${keyId}: ${migrationError.message}`)
        return null // Fail securely - don't return potentially compromised data
      }

      // Check permissions (support both legacy and new formats)
      if (
        userId &&
        keyData.userId !== userId &&
        !(keyData.owner === userId && keyData.ownerType === 'user')
      ) {
        return null
      }

      const usage = await redis.getUsageStats(keyData.id)
      const costStats = await redis.getCostStats(keyData.id)

      return {
        ...keyData,
        usage,
        costStats,
        // Include both formats for compatibility
        userId: keyData.userId || (keyData.ownerType === 'user' ? keyData.owner : ''),
        userUsername: keyData.userUsername || (keyData.ownerType === 'user' ? keyData.owner : ''),
        owner: keyData.owner,
        ownerType: keyData.ownerType
      }
    } catch (error) {
      logger.error('❌ Failed to get API key by ID:', error)
      throw error
    }
  }

  // 🚫 Disable user API Keys (legacy compatibility method)
  async disableUserApiKeys(userId) {
    try {
      const userKeys = await this.getUserApiKeys(userId)
      let disabledCount = 0

      for (const key of userKeys) {
        if (key.isActive === 'true' || key.isActive === true) {
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
}

// 导出实例和单独的方法
const apiKeyService = new ApiKeyService()

// 为了方便其他服务调用，导出 recordUsage 方法
apiKeyService.recordUsageMetrics = apiKeyService.recordUsage.bind(apiKeyService)

module.exports = apiKeyService
