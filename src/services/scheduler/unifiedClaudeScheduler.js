const claudeAccountService = require('../account/claudeAccountService')
const claudeConsoleAccountService = require('../account/claudeConsoleAccountService')
const bedrockAccountService = require('../account/bedrockAccountService')
const gcpVertexAccountService = require('../account/gcpVertexAccountService')
const ccrAccountService = require('../account/ccrAccountService')
const accountGroupService = require('../accountGroupService')
const redis = require('../../models/redis')
const logger = require('../../utils/logger')
const { parseVendorPrefixedModel, isOpus45OrNewer, isClaudeFamilyModel } = require('../../utils/modelHelper')
const { isSchedulable, sortAccountsByPriority } = require('../../utils/commonHelper')
const upstreamErrorHelper = require('../../utils/upstreamErrorHelper')

/**
 * Check if account is Pro (not Max)
 *
 * ACCOUNT TYPE LOGIC (as of 2025-12-05):
 * Pro accounts can be identified by either:
 *   1. API real-time data: hasClaudePro=true && hasClaudeMax=false
 *   2. Local config data: accountType='claude_pro'
 *
 * Account type restrictions for Opus models:
 *   - Free account: No Opus access at all
 *   - Pro account: Only Opus 4.5+ (new versions)
 *   - Max account: All Opus versions (legacy 3.x, 4.0, 4.1 and new 4.5+)
 *
 * Compatible with both API real-time data (hasClaudePro) and local config (accountType)
 * @param {Object} info - Subscription info object
 * @returns {boolean} - true if Pro account (not Free, not Max)
 */
function isProAccount(info) {
  // API real-time status takes priority
  if (info.hasClaudePro === true && info.hasClaudeMax !== true) {
    return true
  }
  // Local configured account type
  return info.accountType === 'claude_pro'
}

class UnifiedClaudeScheduler {
  constructor() {
    this.SESSION_MAPPING_PREFIX = 'unified_claude_session_mapping:'
  }

  // 🔍 检查账户是否支持请求的模型
  _isModelSupportedByAccount(account, accountType, requestedModel, context = '') {
    if (!requestedModel) {
      return true // 没有指定模型时，默认支持
    }

    // Claude OAuth 账户的模型检查
    if (accountType === 'claude-official') {
      // 1. 首先检查是否为 Claude 官方支持的模型
      // Claude Official API 只支持 Anthropic 自己的模型,不支持第三方模型(如 deepseek-chat)
      const isClaudeOfficialModel =
        requestedModel.startsWith('claude-') ||
        requestedModel.includes('claude') ||
        requestedModel.includes('sonnet') ||
        requestedModel.includes('opus') ||
        requestedModel.includes('haiku')

      if (!isClaudeOfficialModel) {
        logger.info(
          `🚫 Claude official account ${account.name} does not support non-Claude model ${requestedModel}${context ? ` ${context}` : ''}`
        )
        return false
      }

      // 2. Opus model subscription level check
      // VERSION RESTRICTION LOGIC:
      // - Free: No Opus models
      // - Pro: Only Opus 4.5+ (isOpus45OrNewer = true)
      // - Max: All Opus versions
      if (requestedModel.toLowerCase().includes('opus')) {
        const isNewOpus = isOpus45OrNewer(requestedModel)

        if (account.subscriptionInfo) {
          try {
            const info =
              typeof account.subscriptionInfo === 'string'
                ? JSON.parse(account.subscriptionInfo)
                : account.subscriptionInfo

            // Free account: does not support any Opus model
            if (info.accountType === 'free') {
              logger.info(
                `🚫 Claude account ${account.name} (Free) does not support Opus model${context ? ` ${context}` : ''}`
              )
              return false
            }

            // Pro account: only supports Opus 4.5+
            // Reject legacy Opus (3.x, 4.0-4.4) but allow new Opus (4.5+)
            if (isProAccount(info)) {
              if (!isNewOpus) {
                logger.info(
                  `🚫 Claude account ${account.name} (Pro) does not support legacy Opus model${context ? ` ${context}` : ''}`
                )
                return false
              }
              // Opus 4.5+ supported
              return true
            }

            // Max account: supports all Opus versions (no restriction)
          } catch (e) {
            // Parse failed, assume legacy data (Max), default support
            logger.debug(
              `Account ${account.name} has invalid subscriptionInfo${context ? ` ${context}` : ''}, assuming Max`
            )
          }
        }
        // Account without subscription info, default to supported (legacy data compatibility)
      }
    }

    // Claude Console 账户的模型支持检查
    if (accountType === 'claude-console' && account.supportedModels) {
      // 兼容旧格式（数组）和新格式（对象）
      if (Array.isArray(account.supportedModels)) {
        // 旧格式：数组
        if (
          account.supportedModels.length > 0 &&
          !account.supportedModels.includes(requestedModel)
        ) {
          logger.info(
            `🚫 Claude Console account ${account.name} does not support model ${requestedModel}${context ? ` ${context}` : ''}`
          )
          return false
        }
      } else if (typeof account.supportedModels === 'object') {
        // 新格式：映射表
        if (
          Object.keys(account.supportedModels).length > 0 &&
          !claudeConsoleAccountService.isModelSupported(account.supportedModels, requestedModel)
        ) {
          logger.info(
            `🚫 Claude Console account ${account.name} does not support model ${requestedModel}${context ? ` ${context}` : ''}`
          )
          return false
        }
      }
    }

    // GCP Vertex 账户仅支持 Claude 家族模型
    if (accountType === 'claude-vertex') {
      if (!isClaudeFamilyModel(requestedModel)) {
        logger.info(
          `🚫 GCP Vertex account ${account.name} does not support non-Claude model ${requestedModel}${context ? ` ${context}` : ''}`
        )
        return false
      }
    }

    // CCR 账户的模型支持检查
    if (accountType === 'ccr' && account.supportedModels) {
      // 兼容旧格式（数组）和新格式（对象）
      if (Array.isArray(account.supportedModels)) {
        // 旧格式：数组
        if (
          account.supportedModels.length > 0 &&
          !account.supportedModels.includes(requestedModel)
        ) {
          logger.info(
            `🚫 CCR account ${account.name} does not support model ${requestedModel}${context ? ` ${context}` : ''}`
          )
          return false
        }
      } else if (typeof account.supportedModels === 'object') {
        // 新格式：映射表
        if (
          Object.keys(account.supportedModels).length > 0 &&
          !ccrAccountService.isModelSupported(account.supportedModels, requestedModel)
        ) {
          logger.info(
            `🚫 CCR account ${account.name} does not support model ${requestedModel}${context ? ` ${context}` : ''}`
          )
          return false
        }
      }
    }

    return true
  }

  // 🎯 统一调度Claude账号（官方和Console）
  async selectAccountForApiKey(
    apiKeyData,
    sessionHash = null,
    requestedModel = null,
    forcedAccount = null
  ) {
    try {
      // 🔒 如果有强制绑定的账户（全局会话绑定），仅 claude-official 类型受影响
      if (forcedAccount && forcedAccount.accountId && forcedAccount.accountType) {
        // ⚠️ 只有 claude-official 类型账户受全局会话绑定限制
        // 其他类型（bedrock, ccr, claude-console等）忽略绑定，走正常调度
        if (forcedAccount.accountType !== 'claude-official') {
          logger.info(
            `🔗 Session binding ignored for non-official account type: ${forcedAccount.accountType}, proceeding with normal scheduling`
          )
          // 不使用 forcedAccount，继续走下面的正常调度逻辑
        } else {
          // claude-official 类型需要检查可用性并强制使用
          logger.info(
            `🔗 Forced session binding detected: ${forcedAccount.accountId} (${forcedAccount.accountType})`
          )

          const isAvailable = await this._isAccountAvailableForSessionBinding(
            forcedAccount.accountId,
            forcedAccount.accountType,
            requestedModel
          )

          if (isAvailable) {
            logger.info(
              `✅ Using forced session binding account: ${forcedAccount.accountId} (${forcedAccount.accountType})`
            )
            return {
              accountId: forcedAccount.accountId,
              accountType: forcedAccount.accountType
            }
          } else {
            // 绑定账户不可用，抛出特定错误（不 fallback）
            logger.warn(
              `❌ Forced session binding account unavailable: ${forcedAccount.accountId} (${forcedAccount.accountType})`
            )
            const error = new Error('Session binding account unavailable')
            error.code = 'SESSION_BINDING_ACCOUNT_UNAVAILABLE'
            error.accountId = forcedAccount.accountId
            error.accountType = forcedAccount.accountType
            throw error
          }
        }
      }

      // 解析供应商前缀
      const { vendor, baseModel } = parseVendorPrefixedModel(requestedModel)
      const effectiveModel = vendor === 'ccr' ? baseModel : requestedModel

      logger.debug(
        `🔍 Model parsing - Original: ${requestedModel}, Vendor: ${vendor}, Effective: ${effectiveModel}`
      )
      const isOpusRequest =
        effectiveModel && typeof effectiveModel === 'string'
          ? effectiveModel.toLowerCase().includes('opus')
          : false

      // 如果是 CCR 前缀，只在 CCR 账户池中选择
      if (vendor === 'ccr') {
        logger.info(`🎯 CCR vendor prefix detected, routing to CCR accounts only`)
        return await this._selectCcrAccount(apiKeyData, sessionHash, effectiveModel)
      }
      // 如果API Key绑定了专属账户或分组，优先使用
      if (apiKeyData.claudeAccountId) {
        // 检查是否是分组
        if (apiKeyData.claudeAccountId.startsWith('group:')) {
          const groupId = apiKeyData.claudeAccountId.replace('group:', '')
          logger.info(
            `🎯 API key ${apiKeyData.name} is bound to group ${groupId}, selecting from group`
          )
          return await this.selectAccountFromGroup(
            groupId,
            sessionHash,
            effectiveModel,
            vendor === 'ccr'
          )
        }

        // 普通专属账户
        const boundAccount = await redis.getClaudeAccount(apiKeyData.claudeAccountId)
        if (boundAccount && boundAccount.isActive === 'true' && boundAccount.status !== 'error') {
          // 检查是否临时不可用
          const isTempUnavailable = await this.isAccountTemporarilyUnavailable(
            boundAccount.id,
            'claude-official'
          )
          if (isTempUnavailable) {
            logger.warn(
              `⏱️ Bound Claude OAuth account ${boundAccount.id} is temporarily unavailable, falling back to pool`
            )
          } else {
            const isRateLimited = await claudeAccountService.isAccountRateLimited(boundAccount.id)
            if (isRateLimited) {
              const rateInfo = await claudeAccountService.getAccountRateLimitInfo(boundAccount.id)
              const error = new Error('Dedicated Claude account is rate limited')
              error.code = 'CLAUDE_DEDICATED_RATE_LIMITED'
              error.accountId = boundAccount.id
              error.rateLimitEndAt = rateInfo?.rateLimitEndAt || boundAccount.rateLimitEndAt || null
              throw error
            }

            if (!isSchedulable(boundAccount.schedulable)) {
              logger.warn(
                `⚠️ Bound Claude OAuth account ${apiKeyData.claudeAccountId} is not schedulable (schedulable: ${boundAccount?.schedulable}), falling back to pool`
              )
            } else {
              if (isOpusRequest) {
                await claudeAccountService.clearExpiredOpusRateLimit(boundAccount.id)
              }
              logger.info(
                `🎯 Using bound dedicated Claude OAuth account: ${boundAccount.name} (${apiKeyData.claudeAccountId}) for API key ${apiKeyData.name}`
              )
              return {
                accountId: apiKeyData.claudeAccountId,
                accountType: 'claude-official'
              }
            }
          }
        } else {
          logger.warn(
            `⚠️ Bound Claude OAuth account ${apiKeyData.claudeAccountId} is not available (isActive: ${boundAccount?.isActive}, status: ${boundAccount?.status}), falling back to pool`
          )
        }
      }

      // 2. 检查Claude Console账户绑定
      if (apiKeyData.claudeConsoleAccountId) {
        const boundConsoleAccount = await claudeConsoleAccountService.getAccount(
          apiKeyData.claudeConsoleAccountId
        )
        if (
          boundConsoleAccount &&
          boundConsoleAccount.isActive === true &&
          boundConsoleAccount.status === 'active' &&
          isSchedulable(boundConsoleAccount.schedulable)
        ) {
          // 检查是否临时不可用
          const isTempUnavailable = await this.isAccountTemporarilyUnavailable(
            boundConsoleAccount.id,
            'claude-console'
          )
          if (isTempUnavailable) {
            logger.warn(
              `⏱️ Bound Claude Console account ${boundConsoleAccount.id} is temporarily unavailable, falling back to pool`
            )
          } else {
            logger.info(
              `🎯 Using bound dedicated Claude Console account: ${boundConsoleAccount.name} (${apiKeyData.claudeConsoleAccountId}) for API key ${apiKeyData.name}`
            )
            return {
              accountId: apiKeyData.claudeConsoleAccountId,
              accountType: 'claude-console'
            }
          }
        } else {
          logger.warn(
            `⚠️ Bound Claude Console account ${apiKeyData.claudeConsoleAccountId} is not available (isActive: ${boundConsoleAccount?.isActive}, status: ${boundConsoleAccount?.status}, schedulable: ${boundConsoleAccount?.schedulable}), falling back to pool`
          )
        }
      }

      // 3. 检查Bedrock账户绑定
      if (apiKeyData.bedrockAccountId) {
        const boundBedrockAccountResult = await bedrockAccountService.getAccount(
          apiKeyData.bedrockAccountId
        )
        if (
          boundBedrockAccountResult.success &&
          boundBedrockAccountResult.data.isActive === true &&
          isSchedulable(boundBedrockAccountResult.data.schedulable)
        ) {
          // 检查是否临时不可用
          const isTempUnavailable = await this.isAccountTemporarilyUnavailable(
            apiKeyData.bedrockAccountId,
            'bedrock'
          )
          if (isTempUnavailable) {
            logger.warn(
              `⏱️ Bound Bedrock account ${apiKeyData.bedrockAccountId} is temporarily unavailable, falling back to pool`
            )
          } else {
            logger.info(
              `🎯 Using bound dedicated Bedrock account: ${boundBedrockAccountResult.data.name} (${apiKeyData.bedrockAccountId}) for API key ${apiKeyData.name}`
            )
            return {
              accountId: apiKeyData.bedrockAccountId,
              accountType: 'bedrock'
            }
          }
        } else {
          logger.warn(
            `⚠️ Bound Bedrock account ${apiKeyData.bedrockAccountId} is not available (isActive: ${boundBedrockAccountResult?.data?.isActive}, schedulable: ${boundBedrockAccountResult?.data?.schedulable}), falling back to pool`
          )
        }
      }

      // 4. 检查GCP Vertex账户绑定
      if (apiKeyData.claudeVertexAccountId) {
        if (apiKeyData.claudeVertexAccountId.startsWith('group:')) {
          const groupId = apiKeyData.claudeVertexAccountId.replace('group:', '')
          logger.info(
            `🎯 API key ${apiKeyData.name} is bound to Vertex group ${groupId}, selecting from group`
          )
          return await this.selectAccountFromGroup(
            groupId,
            sessionHash,
            effectiveModel,
            vendor === 'ccr',
            ['claude-vertex']
          )
        }

        const boundVertexAccount = await gcpVertexAccountService.getAccount(
          apiKeyData.claudeVertexAccountId
        )
        if (
          boundVertexAccount &&
          boundVertexAccount.isActive === true &&
          isSchedulable(boundVertexAccount.schedulable) &&
          this._isModelSupportedByAccount(boundVertexAccount, 'claude-vertex', effectiveModel)
        ) {
          const isTempUnavailable = await this.isAccountTemporarilyUnavailable(
            apiKeyData.claudeVertexAccountId,
            'claude-vertex'
          )
          if (isTempUnavailable) {
            logger.warn(
              `⏱️ Bound GCP Vertex account ${apiKeyData.claudeVertexAccountId} is temporarily unavailable, falling back to pool`
            )
          } else {
            const isRateLimited = await gcpVertexAccountService.isAccountRateLimited(
              apiKeyData.claudeVertexAccountId
            )
            if (isRateLimited) {
              logger.warn(
                `⏱️ Bound GCP Vertex account ${apiKeyData.claudeVertexAccountId} is rate limited, falling back to pool`
              )
            } else {
              logger.info(
                `🎯 Using bound dedicated GCP Vertex account: ${boundVertexAccount.name} (${apiKeyData.claudeVertexAccountId}) for API key ${apiKeyData.name}`
              )
              return {
                accountId: apiKeyData.claudeVertexAccountId,
                accountType: 'claude-vertex'
              }
            }
          }
        } else {
          logger.warn(
            `⚠️ Bound GCP Vertex account ${apiKeyData.claudeVertexAccountId} is not available (isActive: ${boundVertexAccount?.isActive}, schedulable: ${boundVertexAccount?.schedulable}), falling back to pool`
          )
        }
      }

      // CCR 账户不支持绑定（仅通过 ccr, 前缀进行 CCR 路由）

      // 如果有会话哈希，检查是否有已映射的账户
      if (sessionHash) {
        const mappedAccount = await this._getSessionMapping(sessionHash)
        if (mappedAccount) {
          // 当本次请求不是 CCR 前缀时，不允许使用指向 CCR 的粘性会话映射
          if (vendor !== 'ccr' && mappedAccount.accountType === 'ccr') {
            logger.info(
              `ℹ️ Skipping CCR sticky session mapping for non-CCR request; removing mapping for session ${sessionHash}`
            )
            await this._deleteSessionMapping(sessionHash)
          } else {
            // 验证映射的账户是否仍然可用
            const isAvailable = await this._isAccountAvailable(
              mappedAccount.accountId,
              mappedAccount.accountType,
              effectiveModel
            )
            if (isAvailable) {
              // 🚀 智能会话续期：剩余时间少于14天时自动续期到15天（续期正确的 unified 映射键）
              await this._extendSessionMappingTTL(sessionHash)
              logger.info(
                `🎯 Using sticky session account: ${mappedAccount.accountId} (${mappedAccount.accountType}) for session ${sessionHash}`
              )
              return mappedAccount
            } else {
              logger.warn(
                `⚠️ Mapped account ${mappedAccount.accountId} is no longer available, selecting new account`
              )
              await this._deleteSessionMapping(sessionHash)
            }
          }
        }
      }

      // 获取所有可用账户（传递请求的模型进行过滤）
      const availableAccounts = await this._getAllAvailableAccounts(
        apiKeyData,
        effectiveModel,
        false // 仅前缀才走 CCR：默认池不包含 CCR 账户
      )

      if (availableAccounts.length === 0) {
        // 提供更详细的错误信息
        if (effectiveModel) {
          throw new Error(
            `No available Claude accounts support the requested model: ${effectiveModel}`
          )
        } else {
          throw new Error('No available Claude accounts (neither official nor console)')
        }
      }

      // 按优先级和最后使用时间排序
      const sortedAccounts = sortAccountsByPriority(availableAccounts)

      // 选择第一个账户
      const selectedAccount = sortedAccounts[0]

      // 如果有会话哈希，建立新的映射
      if (sessionHash) {
        await this._setSessionMapping(
          sessionHash,
          selectedAccount.accountId,
          selectedAccount.accountType
        )
        logger.info(
          `🎯 Created new sticky session mapping: ${selectedAccount.name} (${selectedAccount.accountId}, ${selectedAccount.accountType}) for session ${sessionHash}`
        )
      }

      logger.info(
        `🎯 Selected account: ${selectedAccount.name} (${selectedAccount.accountId}, ${selectedAccount.accountType}) with priority ${selectedAccount.priority} for API key ${apiKeyData.name}`
      )

      return {
        accountId: selectedAccount.accountId,
        accountType: selectedAccount.accountType
      }
    } catch (error) {
      logger.error('❌ Failed to select account for API key:', error)
      throw error
    }
  }

  // 📋 获取所有可用账户（合并官方和Console）
  async _getAllAvailableAccounts(apiKeyData, requestedModel = null, includeCcr = false) {
    const availableAccounts = []
    const isOpusRequest =
      requestedModel && typeof requestedModel === 'string'
        ? requestedModel.toLowerCase().includes('opus')
        : false

    // 如果API Key绑定了专属账户，优先返回
    // 1. 检查Claude OAuth账户绑定
    if (apiKeyData.claudeAccountId) {
      const boundAccount = await redis.getClaudeAccount(apiKeyData.claudeAccountId)
      if (
        boundAccount &&
        boundAccount.isActive === 'true' &&
        boundAccount.status !== 'error' &&
        boundAccount.status !== 'blocked' &&
        boundAccount.status !== 'temp_error'
      ) {
        const isRateLimited = await claudeAccountService.isAccountRateLimited(boundAccount.id)
        if (isRateLimited) {
          const rateInfo = await claudeAccountService.getAccountRateLimitInfo(boundAccount.id)
          const error = new Error('Dedicated Claude account is rate limited')
          error.code = 'CLAUDE_DEDICATED_RATE_LIMITED'
          error.accountId = boundAccount.id
          error.rateLimitEndAt = rateInfo?.rateLimitEndAt || boundAccount.rateLimitEndAt || null
          throw error
        }

        if (!isSchedulable(boundAccount.schedulable)) {
          logger.warn(
            `⚠️ Bound Claude OAuth account ${apiKeyData.claudeAccountId} is not schedulable (schedulable: ${boundAccount?.schedulable})`
          )
        } else {
          logger.info(
            `🎯 Using bound dedicated Claude OAuth account: ${boundAccount.name} (${apiKeyData.claudeAccountId})`
          )
          return [
            {
              ...boundAccount,
              accountId: boundAccount.id,
              accountType: 'claude-official',
              priority: parseInt(boundAccount.priority) || 50,
              lastUsedAt: boundAccount.lastUsedAt || '0'
            }
          ]
        }
      } else {
        logger.warn(
          `⚠️ Bound Claude OAuth account ${apiKeyData.claudeAccountId} is not available (isActive: ${boundAccount?.isActive}, status: ${boundAccount?.status})`
        )
      }
    }

    // 2. 检查Claude Console账户绑定
    if (apiKeyData.claudeConsoleAccountId) {
      const boundConsoleAccount = await claudeConsoleAccountService.getAccount(
        apiKeyData.claudeConsoleAccountId
      )
      if (
        boundConsoleAccount &&
        boundConsoleAccount.isActive === true &&
        boundConsoleAccount.status === 'active' &&
        isSchedulable(boundConsoleAccount.schedulable)
      ) {
        // 主动触发一次额度检查
        try {
          await claudeConsoleAccountService.checkQuotaUsage(boundConsoleAccount.id)
        } catch (e) {
          logger.warn(
            `Failed to check quota for bound Claude Console account ${boundConsoleAccount.name}: ${e.message}`
          )
          // 继续使用该账号
        }

        // 检查限流状态和额度状态
        const isRateLimited = await claudeConsoleAccountService.isAccountRateLimited(
          boundConsoleAccount.id
        )
        const isQuotaExceeded = await claudeConsoleAccountService.isAccountQuotaExceeded(
          boundConsoleAccount.id
        )

        if (!isRateLimited && !isQuotaExceeded) {
          logger.info(
            `🎯 Using bound dedicated Claude Console account: ${boundConsoleAccount.name} (${apiKeyData.claudeConsoleAccountId})`
          )
          return [
            {
              ...boundConsoleAccount,
              accountId: boundConsoleAccount.id,
              accountType: 'claude-console',
              priority: parseInt(boundConsoleAccount.priority) || 50,
              lastUsedAt: boundConsoleAccount.lastUsedAt || '0'
            }
          ]
        }
      } else {
        logger.warn(
          `⚠️ Bound Claude Console account ${apiKeyData.claudeConsoleAccountId} is not available (isActive: ${boundConsoleAccount?.isActive}, status: ${boundConsoleAccount?.status}, schedulable: ${boundConsoleAccount?.schedulable})`
        )
      }
    }

    // 3. 检查Bedrock账户绑定
    if (apiKeyData.bedrockAccountId) {
      const boundBedrockAccountResult = await bedrockAccountService.getAccount(
        apiKeyData.bedrockAccountId
      )
      if (
        boundBedrockAccountResult.success &&
        boundBedrockAccountResult.data.isActive === true &&
        isSchedulable(boundBedrockAccountResult.data.schedulable)
      ) {
        logger.info(
          `🎯 Using bound dedicated Bedrock account: ${boundBedrockAccountResult.data.name} (${apiKeyData.bedrockAccountId})`
        )
        return [
          {
            ...boundBedrockAccountResult.data,
            accountId: boundBedrockAccountResult.data.id,
            accountType: 'bedrock',
            priority: parseInt(boundBedrockAccountResult.data.priority) || 50,
            lastUsedAt: boundBedrockAccountResult.data.lastUsedAt || '0'
          }
        ]
      } else {
        logger.warn(
          `⚠️ Bound Bedrock account ${apiKeyData.bedrockAccountId} is not available (isActive: ${boundBedrockAccountResult?.data?.isActive}, schedulable: ${boundBedrockAccountResult?.data?.schedulable})`
        )
      }
    }

    // 4. 检查GCP Vertex账户绑定
    if (apiKeyData.claudeVertexAccountId) {
      const boundVertexAccount = await gcpVertexAccountService.getAccount(
        apiKeyData.claudeVertexAccountId
      )
      if (
        boundVertexAccount &&
        boundVertexAccount.isActive === true &&
        isSchedulable(boundVertexAccount.schedulable) &&
        this._isModelSupportedByAccount(boundVertexAccount, 'claude-vertex', requestedModel)
      ) {
        const isTempUnavailable = await this.isAccountTemporarilyUnavailable(
          apiKeyData.claudeVertexAccountId,
          'claude-vertex'
        )
        if (isTempUnavailable) {
          logger.warn(
            `⏱️ Bound GCP Vertex account ${apiKeyData.claudeVertexAccountId} is temporarily unavailable`
          )
        } else {
          const isRateLimited = await gcpVertexAccountService.isAccountRateLimited(
            apiKeyData.claudeVertexAccountId
          )
          if (isRateLimited) {
            logger.warn(
              `⏱️ Bound GCP Vertex account ${apiKeyData.claudeVertexAccountId} is rate limited`
            )
          } else {
            logger.info(
              `🎯 Using bound dedicated GCP Vertex account: ${boundVertexAccount.name} (${apiKeyData.claudeVertexAccountId})`
            )
            return [
              {
                ...boundVertexAccount,
                accountId: boundVertexAccount.id,
                accountType: 'claude-vertex',
                priority: parseInt(boundVertexAccount.priority) || 50,
                lastUsedAt: boundVertexAccount.lastUsedAt || '0'
              }
            ]
          }
        }
      } else {
        logger.warn(
          `⚠️ Bound GCP Vertex account ${apiKeyData.claudeVertexAccountId} is not available (isActive: ${boundVertexAccount?.isActive}, schedulable: ${boundVertexAccount?.schedulable})`
        )
      }
    }

    // 获取官方Claude账户（共享池）
    const claudeAccounts = await redis.getAllClaudeAccounts()
    for (const account of claudeAccounts) {
      if (
        account.isActive === 'true' &&
        account.status !== 'error' &&
        account.status !== 'blocked' &&
        account.status !== 'temp_error' &&
        (account.accountType === 'shared' || !account.accountType) && // 兼容旧数据
        isSchedulable(account.schedulable)
      ) {
        // 检查是否可调度

        // 检查模型支持
        if (!this._isModelSupportedByAccount(account, 'claude-official', requestedModel)) {
          continue
        }

        // 检查是否临时不可用
        const isTempUnavailable = await this.isAccountTemporarilyUnavailable(
          account.id,
          'claude-official'
        )
        if (isTempUnavailable) {
          logger.debug(
            `⏭️ Skipping Claude Official account ${account.name} - temporarily unavailable`
          )
          continue
        }

        // 检查是否被限流
        const isRateLimited = await claudeAccountService.isAccountRateLimited(account.id)
        if (isRateLimited) {
          continue
        }

        if (isOpusRequest) {
          const isOpusRateLimited = await claudeAccountService.isAccountOpusRateLimited(account.id)
          if (isOpusRateLimited) {
            logger.info(
              `🚫 Skipping account ${account.name} (${account.id}) due to active Opus limit`
            )
            continue
          }
        }

        availableAccounts.push({
          ...account,
          accountId: account.id,
          accountType: 'claude-official',
          priority: parseInt(account.priority) || 50, // 默认优先级50
          lastUsedAt: account.lastUsedAt || '0'
        })
      }
    }

    // 获取Claude Console账户
    const consoleAccounts = await claudeConsoleAccountService.getAllAccounts()
    logger.info(`📋 Found ${consoleAccounts.length} total Claude Console accounts`)

    // 🔢 统计Console账户并发排除情况
    let consoleAccountsEligibleCount = 0 // 符合基本条件的账户数
    let consoleAccountsExcludedByConcurrency = 0 // 因并发满额被排除的账户数

    // 🚀 收集需要并发检查的账户ID列表（批量查询优化）
    const accountsNeedingConcurrencyCheck = []

    for (const account of consoleAccounts) {
      // 主动检查封禁状态并尝试恢复（在过滤之前执行，确保可以恢复被封禁的账户）
      const wasBlocked = await claudeConsoleAccountService.isAccountBlocked(account.id)

      // 如果账户之前被封禁但现在已恢复，重新获取最新状态
      let currentAccount = account
      if (wasBlocked === false && account.status === 'account_blocked') {
        // 可能刚刚被恢复，重新获取账户状态
        const freshAccount = await claudeConsoleAccountService.getAccount(account.id)
        if (freshAccount) {
          currentAccount = freshAccount
          logger.info(`🔄 Account ${account.name} was recovered from blocked status`)
        }
      }

      // 主动检查配额超限状态并尝试恢复（在过滤之前执行，确保可以恢复配额超限的账户）
      if (currentAccount.status === 'quota_exceeded') {
        // 触发配额检查，如果已到重置时间会自动恢复账户
        const isStillExceeded = await claudeConsoleAccountService.isAccountQuotaExceeded(
          currentAccount.id
        )
        if (!isStillExceeded) {
          // 重新获取账户最新状态
          const refreshedAccount = await claudeConsoleAccountService.getAccount(currentAccount.id)
          if (refreshedAccount) {
            // 更新当前循环中的账户数据
            currentAccount = refreshedAccount
            logger.info(`✅ Account ${currentAccount.name} recovered from quota_exceeded status`)
          }
        }
      }

      logger.info(
        `🔍 Checking Claude Console account: ${currentAccount.name} - isActive: ${currentAccount.isActive}, status: ${currentAccount.status}, accountType: ${currentAccount.accountType}, schedulable: ${currentAccount.schedulable}`
      )

      // 注意：getAllAccounts返回的isActive是布尔值，getAccount返回的也是布尔值
      if (
        currentAccount.isActive === true &&
        currentAccount.status === 'active' &&
        currentAccount.accountType === 'shared' &&
        isSchedulable(currentAccount.schedulable)
      ) {
        // 检查是否可调度

        // 检查模型支持
        if (!this._isModelSupportedByAccount(currentAccount, 'claude-console', requestedModel)) {
          continue
        }

        // 检查订阅是否过期
        if (claudeConsoleAccountService.isSubscriptionExpired(currentAccount)) {
          logger.debug(
            `⏰ Claude Console account ${currentAccount.name} (${currentAccount.id}) expired at ${currentAccount.subscriptionExpiresAt}`
          )
          continue
        }

        // 主动触发一次额度检查，确保状态即时生效
        try {
          await claudeConsoleAccountService.checkQuotaUsage(currentAccount.id)
        } catch (e) {
          logger.warn(
            `Failed to check quota for Claude Console account ${currentAccount.name}: ${e.message}`
          )
          // 继续处理该账号
        }

        // 检查是否临时不可用
        const isTempUnavailable = await this.isAccountTemporarilyUnavailable(
          currentAccount.id,
          'claude-console'
        )
        if (isTempUnavailable) {
          logger.debug(
            `⏭️ Skipping Claude Console account ${currentAccount.name} - temporarily unavailable`
          )
          continue
        }

        // 检查是否被限流
        const isRateLimited = await claudeConsoleAccountService.isAccountRateLimited(
          currentAccount.id
        )
        const isQuotaExceeded = await claudeConsoleAccountService.isAccountQuotaExceeded(
          currentAccount.id
        )

        // 🔢 记录符合基本条件的账户（通过了前面所有检查，但可能因并发被排除）
        if (!isRateLimited && !isQuotaExceeded) {
          consoleAccountsEligibleCount++
          // 🚀 将符合条件且需要并发检查的账户加入批量查询列表
          if (currentAccount.maxConcurrentTasks > 0) {
            accountsNeedingConcurrencyCheck.push(currentAccount)
          } else {
            // 未配置并发限制的账户直接加入可用池
            availableAccounts.push({
              ...currentAccount,
              accountId: currentAccount.id,
              accountType: 'claude-console',
              priority: parseInt(currentAccount.priority) || 50,
              lastUsedAt: currentAccount.lastUsedAt || '0'
            })
            logger.info(
              `✅ Added Claude Console account to available pool: ${currentAccount.name} (priority: ${currentAccount.priority}, no concurrency limit)`
            )
          }
        } else {
          if (isRateLimited) {
            logger.warn(`⚠️ Claude Console account ${currentAccount.name} is rate limited`)
          }
          if (isQuotaExceeded) {
            logger.warn(`💰 Claude Console account ${currentAccount.name} quota exceeded`)
          }
        }
      } else {
        logger.info(
          `❌ Claude Console account ${currentAccount.name} not eligible - isActive: ${currentAccount.isActive}, status: ${currentAccount.status}, accountType: ${currentAccount.accountType}, schedulable: ${currentAccount.schedulable}`
        )
      }
    }

    // 🚀 批量查询所有账户的并发数（Promise.all 并行执行）
    if (accountsNeedingConcurrencyCheck.length > 0) {
      logger.debug(
        `🚀 Batch checking concurrency for ${accountsNeedingConcurrencyCheck.length} accounts`
      )

      const concurrencyCheckPromises = accountsNeedingConcurrencyCheck.map((account) =>
        redis.getConsoleAccountConcurrency(account.id).then((currentConcurrency) => ({
          account,
          currentConcurrency
        }))
      )

      const concurrencyResults = await Promise.all(concurrencyCheckPromises)

      // 处理批量查询结果
      for (const { account, currentConcurrency } of concurrencyResults) {
        const isConcurrencyFull = currentConcurrency >= account.maxConcurrentTasks

        if (!isConcurrencyFull) {
          availableAccounts.push({
            ...account,
            accountId: account.id,
            accountType: 'claude-console',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          })
          logger.info(
            `✅ Added Claude Console account to available pool: ${account.name} (priority: ${account.priority}, concurrency: ${currentConcurrency}/${account.maxConcurrentTasks})`
          )
        } else {
          // 🔢 因并发满额被排除，计数器加1
          consoleAccountsExcludedByConcurrency++
          logger.warn(
            `⚠️ Claude Console account ${account.name} reached concurrency limit: ${currentConcurrency}/${account.maxConcurrentTasks}`
          )
        }
      }
    }

    // 获取Bedrock账户（共享池）
    const bedrockAccountsResult = await bedrockAccountService.getAllAccounts()
    if (bedrockAccountsResult.success) {
      const bedrockAccounts = bedrockAccountsResult.data
      logger.info(`📋 Found ${bedrockAccounts.length} total Bedrock accounts`)

      for (const account of bedrockAccounts) {
        logger.info(
          `🔍 Checking Bedrock account: ${account.name} - isActive: ${account.isActive}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
        )

        if (
          account.isActive === true &&
          account.accountType === 'shared' &&
          isSchedulable(account.schedulable)
        ) {
          // 检查是否临时不可用
          const isTempUnavailable = await this.isAccountTemporarilyUnavailable(
            account.id,
            'bedrock'
          )
          if (isTempUnavailable) {
            logger.debug(`⏭️ Skipping Bedrock account ${account.name} - temporarily unavailable`)
            continue
          }

          availableAccounts.push({
            ...account,
            accountId: account.id,
            accountType: 'bedrock',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          })
          logger.info(
            `✅ Added Bedrock account to available pool: ${account.name} (priority: ${account.priority})`
          )
        } else {
          logger.info(
            `❌ Bedrock account ${account.name} not eligible - isActive: ${account.isActive}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
          )
        }
      }
    }

    // 获取GCP Vertex账户（共享池）
    const vertexAccountsResult = await gcpVertexAccountService.getAllAccounts()
    if (vertexAccountsResult.success) {
      const vertexAccounts = vertexAccountsResult.data
      logger.info(`📋 Found ${vertexAccounts.length} total GCP Vertex accounts`)

      for (const account of vertexAccounts) {
        logger.info(
          `🔍 Checking GCP Vertex account: ${account.name} - isActive: ${account.isActive}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
        )

        if (
          account.isActive === true &&
          account.accountType === 'shared' &&
          isSchedulable(account.schedulable)
        ) {
          // 检查模型支持
          if (!this._isModelSupportedByAccount(account, 'claude-vertex', requestedModel)) {
            continue
          }

          const isTempUnavailable = await this.isAccountTemporarilyUnavailable(
            account.id,
            'claude-vertex'
          )
          if (isTempUnavailable) {
            logger.debug(`⏭️ Skipping GCP Vertex account ${account.name} - temporarily unavailable`)
            continue
          }

          const isRateLimited = await gcpVertexAccountService.isAccountRateLimited(account.id)
          if (isRateLimited) {
            logger.warn(`⚠️ GCP Vertex account ${account.name} is rate limited`)
            continue
          }

          availableAccounts.push({
            ...account,
            accountId: account.id,
            accountType: 'claude-vertex',
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          })
          logger.info(
            `✅ Added GCP Vertex account to available pool: ${account.name} (priority: ${account.priority})`
          )
        } else {
          logger.info(
            `❌ GCP Vertex account ${account.name} not eligible - isActive: ${account.isActive}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
          )
        }
      }
    }

    // 获取CCR账户（共享池）- 仅当明确要求包含时
    if (includeCcr) {
      const ccrAccounts = await ccrAccountService.getAllAccounts()
      logger.info(`📋 Found ${ccrAccounts.length} total CCR accounts`)

      for (const account of ccrAccounts) {
        logger.info(
          `🔍 Checking CCR account: ${account.name} - isActive: ${account.isActive}, status: ${account.status}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
        )

        if (
          account.isActive === true &&
          account.status === 'active' &&
          account.accountType === 'shared' &&
          isSchedulable(account.schedulable)
        ) {
          // 检查模型支持
          if (!this._isModelSupportedByAccount(account, 'ccr', requestedModel)) {
            continue
          }

          // 检查订阅是否过期
          if (ccrAccountService.isSubscriptionExpired(account)) {
            logger.debug(
              `⏰ CCR account ${account.name} (${account.id}) expired at ${account.subscriptionExpiresAt}`
            )
            continue
          }

          // 检查是否临时不可用
          const isTempUnavailable = await this.isAccountTemporarilyUnavailable(account.id, 'ccr')
          if (isTempUnavailable) {
            logger.debug(`⏭️ Skipping CCR account ${account.name} - temporarily unavailable`)
            continue
          }

          // 检查是否被限流
          const isRateLimited = await ccrAccountService.isAccountRateLimited(account.id)
          const isQuotaExceeded = await ccrAccountService.isAccountQuotaExceeded(account.id)

          if (!isRateLimited && !isQuotaExceeded) {
            availableAccounts.push({
              ...account,
              accountId: account.id,
              accountType: 'ccr',
              priority: parseInt(account.priority) || 50,
              lastUsedAt: account.lastUsedAt || '0'
            })
            logger.info(
              `✅ Added CCR account to available pool: ${account.name} (priority: ${account.priority})`
            )
          } else {
            if (isRateLimited) {
              logger.warn(`⚠️ CCR account ${account.name} is rate limited`)
            }
            if (isQuotaExceeded) {
              logger.warn(`💰 CCR account ${account.name} quota exceeded`)
            }
          }
        } else {
          logger.info(
            `❌ CCR account ${account.name} not eligible - isActive: ${account.isActive}, status: ${account.status}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
          )
        }
      }
    }

    logger.info(
      `📊 Total available accounts: ${availableAccounts.length} (Claude: ${availableAccounts.filter((a) => a.accountType === 'claude-official').length}, Console: ${availableAccounts.filter((a) => a.accountType === 'claude-console').length}, Bedrock: ${availableAccounts.filter((a) => a.accountType === 'bedrock').length}, Vertex: ${availableAccounts.filter((a) => a.accountType === 'claude-vertex').length}, CCR: ${availableAccounts.filter((a) => a.accountType === 'ccr').length})`
    )

    // 🚨 最终检查：只有在没有任何可用账户时，才根据Console并发排除情况抛出专用错误码
    if (availableAccounts.length === 0) {
      // 如果所有Console账户都因并发满额被排除，抛出专用错误码（503）
      if (
        consoleAccountsEligibleCount > 0 &&
        consoleAccountsExcludedByConcurrency === consoleAccountsEligibleCount
      ) {
        logger.error(
          `❌ All ${consoleAccountsEligibleCount} eligible Console accounts are at concurrency limit (no other account types available)`
        )
        const error = new Error(
          'All available Claude Console accounts have reached their concurrency limit'
        )
        error.code = 'CONSOLE_ACCOUNT_CONCURRENCY_FULL'
        throw error
      }
      // 否则走通用的"无可用账户"错误处理（由上层 selectAccountForApiKey 捕获）
    }

    return availableAccounts
  }

  // 🔍 检查账户是否可用
  async _isAccountAvailable(accountId, accountType, requestedModel = null) {
    try {
      if (accountType === 'claude-official') {
        const account = await redis.getClaudeAccount(accountId)
        if (
          !account ||
          account.isActive !== 'true' ||
          account.status === 'error' ||
          account.status === 'temp_error'
        ) {
          return false
        }
        // 检查是否可调度
        if (!isSchedulable(account.schedulable)) {
          logger.info(`🚫 Account ${accountId} is not schedulable`)
          return false
        }

        // 检查模型兼容性
        if (
          !this._isModelSupportedByAccount(
            account,
            'claude-official',
            requestedModel,
            'in session check'
          )
        ) {
          return false
        }

        // 检查是否限流或过载
        const isRateLimited = await claudeAccountService.isAccountRateLimited(accountId)
        const isOverloaded = await claudeAccountService.isAccountOverloaded(accountId)
        if (isRateLimited || isOverloaded) {
          return false
        }

        if (
          requestedModel &&
          typeof requestedModel === 'string' &&
          requestedModel.toLowerCase().includes('opus')
        ) {
          const isOpusRateLimited = await claudeAccountService.isAccountOpusRateLimited(accountId)
          if (isOpusRateLimited) {
            logger.info(`🚫 Account ${accountId} skipped due to active Opus limit (session check)`)
            return false
          }
        }

        return true
      } else if (accountType === 'claude-console') {
        const account = await claudeConsoleAccountService.getAccount(accountId)
        if (!account || !account.isActive) {
          return false
        }
        // 检查账户状态
        if (
          account.status !== 'active' &&
          account.status !== 'unauthorized' &&
          account.status !== 'overloaded'
        ) {
          return false
        }
        // 检查是否可调度
        if (!isSchedulable(account.schedulable)) {
          logger.info(`🚫 Claude Console account ${accountId} is not schedulable`)
          return false
        }
        // 检查模型支持
        if (
          !this._isModelSupportedByAccount(
            account,
            'claude-console',
            requestedModel,
            'in session check'
          )
        ) {
          return false
        }
        // 检查订阅是否过期
        if (claudeConsoleAccountService.isSubscriptionExpired(account)) {
          logger.debug(
            `⏰ Claude Console account ${account.name} (${accountId}) expired at ${account.subscriptionExpiresAt} (session check)`
          )
          return false
        }
        // 检查是否超额
        try {
          await claudeConsoleAccountService.checkQuotaUsage(accountId)
        } catch (e) {
          logger.warn(`Failed to check quota for Claude Console account ${accountId}: ${e.message}`)
          // 继续处理
        }

        // 检查是否被限流
        if (await claudeConsoleAccountService.isAccountRateLimited(accountId)) {
          return false
        }
        if (await claudeConsoleAccountService.isAccountQuotaExceeded(accountId)) {
          return false
        }
        // 检查是否未授权（401错误）
        if (account.status === 'unauthorized') {
          return false
        }
        // 检查是否过载（529错误）
        if (await claudeConsoleAccountService.isAccountOverloaded(accountId)) {
          return false
        }

        // 检查并发限制（预检查，真正的原子抢占在 relayService 中进行）
        if (account.maxConcurrentTasks > 0) {
          const currentConcurrency = await redis.getConsoleAccountConcurrency(accountId)
          if (currentConcurrency >= account.maxConcurrentTasks) {
            logger.info(
              `🚫 Claude Console account ${accountId} reached concurrency limit: ${currentConcurrency}/${account.maxConcurrentTasks} (pre-check)`
            )
            return false
          }
        }

        return true
      } else if (accountType === 'bedrock') {
        const accountResult = await bedrockAccountService.getAccount(accountId)
        if (!accountResult.success || !accountResult.data.isActive) {
          return false
        }
        // 检查是否可调度
        if (!isSchedulable(accountResult.data.schedulable)) {
          logger.info(`🚫 Bedrock account ${accountId} is not schedulable`)
          return false
        }
        // Bedrock账户暂不需要限流检查，因为AWS管理限流
        return true
      } else if (accountType === 'claude-vertex') {
        const account = await gcpVertexAccountService.getAccount(accountId)
        if (!account || !account.isActive) {
          return false
        }
        if (!isSchedulable(account.schedulable)) {
          logger.info(`🚫 GCP Vertex account ${accountId} is not schedulable`)
          return false
        }
        if (
          !this._isModelSupportedByAccount(account, 'claude-vertex', requestedModel, 'in session check')
        ) {
          return false
        }
        const isTempUnavailable = await this.isAccountTemporarilyUnavailable(
          accountId,
          'claude-vertex'
        )
        if (isTempUnavailable) {
          return false
        }
        if (await gcpVertexAccountService.isAccountRateLimited(accountId)) {
          return false
        }
        return true
      } else if (accountType === 'ccr') {
        const account = await ccrAccountService.getAccount(accountId)
        if (!account || !account.isActive) {
          return false
        }
        // 检查账户状态
        if (
          account.status !== 'active' &&
          account.status !== 'unauthorized' &&
          account.status !== 'overloaded'
        ) {
          return false
        }
        // 检查是否可调度
        if (!isSchedulable(account.schedulable)) {
          logger.info(`🚫 CCR account ${accountId} is not schedulable`)
          return false
        }
        // 检查模型支持
        if (!this._isModelSupportedByAccount(account, 'ccr', requestedModel, 'in session check')) {
          return false
        }
        // 检查订阅是否过期
        if (ccrAccountService.isSubscriptionExpired(account)) {
          logger.debug(
            `⏰ CCR account ${account.name} (${accountId}) expired at ${account.subscriptionExpiresAt} (session check)`
          )
          return false
        }
        // 检查是否超额
        try {
          await ccrAccountService.checkQuotaUsage(accountId)
        } catch (e) {
          logger.warn(`Failed to check quota for CCR account ${accountId}: ${e.message}`)
          // 继续处理
        }

        // 检查是否被限流
        if (await ccrAccountService.isAccountRateLimited(accountId)) {
          return false
        }
        if (await ccrAccountService.isAccountQuotaExceeded(accountId)) {
          return false
        }
        // 检查是否未授权（401错误）
        if (account.status === 'unauthorized') {
          return false
        }
        // 检查是否过载（529错误）
        if (await ccrAccountService.isAccountOverloaded(accountId)) {
          return false
        }
        return true
      }
      return false
    } catch (error) {
      logger.warn(`⚠️ Failed to check account availability: ${accountId}`, error)
      return false
    }
  }

  // 🔗 获取会话映射
  async _getSessionMapping(sessionHash) {
    const client = redis.getClientSafe()
    const mappingData = await client.get(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`)

    if (mappingData) {
      try {
        return JSON.parse(mappingData)
      } catch (error) {
        logger.warn('⚠️ Failed to parse session mapping:', error)
        return null
      }
    }

    return null
  }

  // 💾 设置会话映射
  async _setSessionMapping(sessionHash, accountId, accountType) {
    const client = redis.getClientSafe()
    const mappingData = JSON.stringify({ accountId, accountType })
    // 依据配置设置TTL（小时）
    const appConfig = require('../../../config/config')
    const ttlHours = appConfig.session?.stickyTtlHours || 1
    const ttlSeconds = Math.max(1, Math.floor(ttlHours * 60 * 60))
    await client.setex(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`, ttlSeconds, mappingData)
  }

  // 🗑️ 删除会话映射
  async _deleteSessionMapping(sessionHash) {
    const client = redis.getClientSafe()
    await client.del(`${this.SESSION_MAPPING_PREFIX}${sessionHash}`)
  }

  /**
   * 🧹 公共方法：清理粘性会话映射（用于并发满额时的降级处理）
   * @param {string} sessionHash - 会话哈希值
   */
  async clearSessionMapping(sessionHash) {
    // 防御空会话哈希
    if (!sessionHash || typeof sessionHash !== 'string') {
      logger.debug('⚠️ Skipping session mapping clear - invalid sessionHash')
      return
    }

    try {
      await this._deleteSessionMapping(sessionHash)
      logger.info(
        `🧹 Cleared sticky session mapping for session: ${sessionHash.substring(0, 8)}...`
      )
    } catch (error) {
      logger.error(`❌ Failed to clear session mapping for ${sessionHash}:`, error)
      throw error
    }
  }

  // 🔁 续期统一调度会话映射TTL（针对 unified_claude_session_mapping:* 键），遵循会话配置
  async _extendSessionMappingTTL(sessionHash) {
    try {
      const client = redis.getClientSafe()
      const key = `${this.SESSION_MAPPING_PREFIX}${sessionHash}`
      const remainingTTL = await client.ttl(key)

      // -2: key 不存在；-1: 无过期时间
      if (remainingTTL === -2) {
        return false
      }
      if (remainingTTL === -1) {
        return true
      }

      const appConfig = require('../../../config/config')
      const ttlHours = appConfig.session?.stickyTtlHours || 1
      const renewalThresholdMinutes = appConfig.session?.renewalThresholdMinutes || 0

      // 阈值为0则不续期
      if (!renewalThresholdMinutes) {
        return true
      }

      const fullTTL = Math.max(1, Math.floor(ttlHours * 60 * 60))
      const threshold = Math.max(0, Math.floor(renewalThresholdMinutes * 60))

      if (remainingTTL < threshold) {
        await client.expire(key, fullTTL)
        logger.debug(
          `🔄 Renewed unified session TTL: ${sessionHash} (was ${Math.round(remainingTTL / 60)}m, renewed to ${ttlHours}h)`
        )
      } else {
        logger.debug(
          `✅ Unified session TTL sufficient: ${sessionHash} (remaining ${Math.round(remainingTTL / 60)}m)`
        )
      }
      return true
    } catch (error) {
      logger.error('❌ Failed to extend unified session TTL:', error)
      return false
    }
  }

  // ⏱️ 标记账户为临时不可用状态（用于5xx等临时故障，默认5分钟后自动恢复）
  async markAccountTemporarilyUnavailable(
    accountId,
    accountType,
    sessionHash = null,
    ttlSeconds = 300
  ) {
    try {
      await upstreamErrorHelper.markTempUnavailable(accountId, accountType, 500, ttlSeconds)
      if (sessionHash) {
        await this._deleteSessionMapping(sessionHash)
      }
      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to mark account temporarily unavailable: ${accountId}`, error)
      return { success: false }
    }
  }

  // 🔍 检查账户是否临时不可用
  async isAccountTemporarilyUnavailable(accountId, accountType) {
    return upstreamErrorHelper.isTempUnavailable(accountId, accountType)
  }

  // 🚫 标记账户为限流状态
  async markAccountRateLimited(
    accountId,
    accountType,
    sessionHash = null,
    rateLimitResetTimestamp = null
  ) {
    try {
      if (accountType === 'claude-official') {
        await claudeAccountService.markAccountRateLimited(
          accountId,
          sessionHash,
          rateLimitResetTimestamp
        )
      } else if (accountType === 'claude-console') {
        await claudeConsoleAccountService.markAccountRateLimited(accountId)
      } else if (accountType === 'claude-vertex') {
        await gcpVertexAccountService.markAccountRateLimited(accountId)
      } else if (accountType === 'ccr') {
        await ccrAccountService.markAccountRateLimited(accountId)
      }

      // 删除会话映射
      if (sessionHash) {
        await this._deleteSessionMapping(sessionHash)
      }

      return { success: true }
    } catch (error) {
      logger.error(
        `❌ Failed to mark account as rate limited: ${accountId} (${accountType})`,
        error
      )
      throw error
    }
  }

  // ✅ 移除账户的限流状态
  async removeAccountRateLimit(accountId, accountType) {
    try {
      if (accountType === 'claude-official') {
        await claudeAccountService.removeAccountRateLimit(accountId)
      } else if (accountType === 'claude-console') {
        await claudeConsoleAccountService.removeAccountRateLimit(accountId)
      } else if (accountType === 'claude-vertex') {
        await gcpVertexAccountService.removeAccountRateLimit(accountId)
      } else if (accountType === 'ccr') {
        await ccrAccountService.removeAccountRateLimit(accountId)
      }

      return { success: true }
    } catch (error) {
      logger.error(
        `❌ Failed to remove rate limit for account: ${accountId} (${accountType})`,
        error
      )
      throw error
    }
  }

  // 🔍 检查账户是否处于限流状态
  async isAccountRateLimited(accountId, accountType) {
    try {
      if (accountType === 'claude-official') {
        return await claudeAccountService.isAccountRateLimited(accountId)
      } else if (accountType === 'claude-console') {
        return await claudeConsoleAccountService.isAccountRateLimited(accountId)
      } else if (accountType === 'claude-vertex') {
        return await gcpVertexAccountService.isAccountRateLimited(accountId)
      } else if (accountType === 'ccr') {
        return await ccrAccountService.isAccountRateLimited(accountId)
      }
      return false
    } catch (error) {
      logger.error(`❌ Failed to check rate limit status: ${accountId} (${accountType})`, error)
      return false
    }
  }

  // 🚫 标记账户为未授权状态（401错误）
  async markAccountUnauthorized(accountId, accountType, sessionHash = null) {
    try {
      // 只处理claude-official类型的账户，不处理claude-console和gemini
      if (accountType === 'claude-official') {
        await claudeAccountService.markAccountUnauthorized(accountId, sessionHash)

        // 删除会话映射
        if (sessionHash) {
          await this._deleteSessionMapping(sessionHash)
        }

        logger.warn(`🚫 Account ${accountId} marked as unauthorized due to consecutive 401 errors`)
      } else {
        logger.info(
          `ℹ️ Skipping unauthorized marking for non-Claude OAuth account: ${accountId} (${accountType})`
        )
      }

      return { success: true }
    } catch (error) {
      logger.error(
        `❌ Failed to mark account as unauthorized: ${accountId} (${accountType})`,
        error
      )
      throw error
    }
  }

  // 🚫 标记账户为被封锁状态（403错误）
  async markAccountBlocked(accountId, accountType, sessionHash = null) {
    try {
      // 只处理claude-official类型的账户，不处理claude-console和gemini
      if (accountType === 'claude-official') {
        await claudeAccountService.markAccountBlocked(accountId, sessionHash)

        // 删除会话映射
        if (sessionHash) {
          await this._deleteSessionMapping(sessionHash)
        }

        logger.warn(`🚫 Account ${accountId} marked as blocked due to 403 error`)
      } else {
        logger.info(
          `ℹ️ Skipping blocked marking for non-Claude OAuth account: ${accountId} (${accountType})`
        )
      }

      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to mark account as blocked: ${accountId} (${accountType})`, error)
      throw error
    }
  }

  // 🚫 标记Claude Console账户为封锁状态（模型不支持）
  async blockConsoleAccount(accountId, reason) {
    try {
      await claudeConsoleAccountService.blockAccount(accountId, reason)
      return { success: true }
    } catch (error) {
      logger.error(`❌ Failed to block console account: ${accountId}`, error)
      throw error
    }
  }

  // 👥 从分组中选择账户
  async selectAccountFromGroup(
    groupId,
    sessionHash = null,
    requestedModel = null,
    allowCcr = false,
    allowedAccountTypes = null
  ) {
    try {
      const isAllowedAccountType = (accountType) =>
        !Array.isArray(allowedAccountTypes) || allowedAccountTypes.includes(accountType)

      // 获取分组信息
      const group = await accountGroupService.getGroup(groupId)
      if (!group) {
        throw new Error(`Group ${groupId} not found`)
      }

      logger.info(`👥 Selecting account from group: ${group.name} (${group.platform})`)

      // 如果有会话哈希，检查是否有已映射的账户
      if (sessionHash) {
        const mappedAccount = await this._getSessionMapping(sessionHash)
        if (mappedAccount) {
          // 验证映射的账户是否属于这个分组
          const memberIds = await accountGroupService.getGroupMembers(groupId)
          if (memberIds.includes(mappedAccount.accountId)) {
            // 非 CCR 请求时不允许 CCR 粘性映射
            if (!isAllowedAccountType(mappedAccount.accountType)) {
              logger.info(
                `ℹ️ Sticky account ${mappedAccount.accountId} (${mappedAccount.accountType}) not allowed by group binding filter, clearing mapping`
              )
            } else if (!allowCcr && mappedAccount.accountType === 'ccr') {
              await this._deleteSessionMapping(sessionHash)
            } else {
              const isAvailable = await this._isAccountAvailable(
                mappedAccount.accountId,
                mappedAccount.accountType,
                requestedModel
              )
              if (isAvailable) {
                // 🚀 智能会话续期：续期 unified 映射键
                await this._extendSessionMappingTTL(sessionHash)
                logger.info(
                  `🎯 Using sticky session account from group: ${mappedAccount.accountId} (${mappedAccount.accountType}) for session ${sessionHash}`
                )
                return mappedAccount
              }
            }
          }
          // 如果映射的账户不可用或不在分组中，删除映射
          await this._deleteSessionMapping(sessionHash)
        }
      }

      // 获取分组内的所有账户
      const memberIds = await accountGroupService.getGroupMembers(groupId)
      if (memberIds.length === 0) {
        throw new Error(`Group ${group.name} has no members`)
      }

      const availableAccounts = []
      const isOpusRequest =
        requestedModel && typeof requestedModel === 'string'
          ? requestedModel.toLowerCase().includes('opus')
          : false

      // 获取所有成员账户的详细信息
      for (const memberId of memberIds) {
        let account = null
        let accountType = null

        // 根据平台类型获取账户
        if (group.platform === 'claude') {
          // 先尝试官方账户
          account = await redis.getClaudeAccount(memberId)
          if (account?.id) {
            accountType = 'claude-official'
          } else {
            // 尝试Console账户
            account = await claudeConsoleAccountService.getAccount(memberId)
            if (account) {
              accountType = 'claude-console'
            } else {
              // 尝试GCP Vertex账户
              account = await gcpVertexAccountService.getAccount(memberId)
              if (account) {
                accountType = 'claude-vertex'
              } else {
                // 尝试CCR账户（仅允许在 allowCcr 为 true 时）
                if (allowCcr) {
                  account = await ccrAccountService.getAccount(memberId)
                  if (account) {
                    accountType = 'ccr'
                  }
                }
              }
            }
          }
        } else if (group.platform === 'gemini') {
          // Gemini暂时不支持，预留接口
          logger.warn('⚠️ Gemini group scheduling not yet implemented')
          continue
        }

        if (!account) {
          logger.warn(`⚠️ Account ${memberId} not found in group ${group.name}`)
          continue
        }

        if (!isAllowedAccountType(accountType)) {
          logger.debug(
            `⏭️ Skipping group member ${memberId} with disallowed account type ${accountType}`
          )
          continue
        }

        // 检查账户是否可用
        const isActive =
          accountType === 'claude-official'
            ? account.isActive === 'true'
            : account.isActive === true

        const status =
          accountType === 'claude-official'
            ? account.status !== 'error' && account.status !== 'blocked'
            : accountType === 'ccr'
              ? account.status === 'active'
              : account.status === 'active'

        if (isActive && status && isSchedulable(account.schedulable)) {
          // 检查模型支持
          if (!this._isModelSupportedByAccount(account, accountType, requestedModel, 'in group')) {
            continue
          }

          // 检查是否被限流
          const isRateLimited = await this.isAccountRateLimited(account.id, accountType)
          if (isRateLimited) {
            continue
          }

          if (accountType === 'claude-official' && isOpusRequest) {
            const isOpusRateLimited = await claudeAccountService.isAccountOpusRateLimited(
              account.id
            )
            if (isOpusRateLimited) {
              logger.info(
                `🚫 Skipping group member ${account.name} (${account.id}) due to active Opus limit`
              )
              continue
            }
          }

          // 🔒 检查 Claude Console 账户的并发限制
          if (accountType === 'claude-console' && account.maxConcurrentTasks > 0) {
            const currentConcurrency = await redis.getConsoleAccountConcurrency(account.id)
            if (currentConcurrency >= account.maxConcurrentTasks) {
              logger.info(
                `🚫 Skipping group member ${account.name} (${account.id}) due to concurrency limit: ${currentConcurrency}/${account.maxConcurrentTasks}`
              )
              continue
            }
          }

          availableAccounts.push({
            ...account,
            accountId: account.id,
            accountType,
            priority: parseInt(account.priority) || 50,
            lastUsedAt: account.lastUsedAt || '0'
          })
        }
      }

      if (availableAccounts.length === 0) {
        throw new Error(`No available accounts in group ${group.name}`)
      }

      // 使用现有的优先级排序逻辑
      const sortedAccounts = sortAccountsByPriority(availableAccounts)

      // 选择第一个账户
      const selectedAccount = sortedAccounts[0]

      // 如果有会话哈希，建立新的映射
      if (sessionHash) {
        await this._setSessionMapping(
          sessionHash,
          selectedAccount.accountId,
          selectedAccount.accountType
        )
        logger.info(
          `🎯 Created new sticky session mapping in group: ${selectedAccount.name} (${selectedAccount.accountId}, ${selectedAccount.accountType}) for session ${sessionHash}`
        )
      }

      logger.info(
        `🎯 Selected account from group ${group.name}: ${selectedAccount.name} (${selectedAccount.accountId}, ${selectedAccount.accountType}) with priority ${selectedAccount.priority}`
      )

      return {
        accountId: selectedAccount.accountId,
        accountType: selectedAccount.accountType
      }
    } catch (error) {
      logger.error(`❌ Failed to select account from group ${groupId}:`, error)
      throw error
    }
  }

  // 🎯 专门选择CCR账户（仅限CCR前缀路由使用）
  async _selectCcrAccount(apiKeyData, sessionHash = null, effectiveModel = null) {
    try {
      // 1. 检查会话粘性
      if (sessionHash) {
        const mappedAccount = await this._getSessionMapping(sessionHash)
        if (mappedAccount && mappedAccount.accountType === 'ccr') {
          // 验证映射的CCR账户是否仍然可用
          const isAvailable = await this._isAccountAvailable(
            mappedAccount.accountId,
            mappedAccount.accountType,
            effectiveModel
          )
          if (isAvailable) {
            // 🚀 智能会话续期：续期 unified 映射键
            await this._extendSessionMappingTTL(sessionHash)
            logger.info(
              `🎯 Using sticky CCR session account: ${mappedAccount.accountId} for session ${sessionHash}`
            )
            return mappedAccount
          } else {
            logger.warn(
              `⚠️ Mapped CCR account ${mappedAccount.accountId} is no longer available, selecting new account`
            )
            await this._deleteSessionMapping(sessionHash)
          }
        }
      }

      // 2. 获取所有可用的CCR账户
      const availableCcrAccounts = await this._getAvailableCcrAccounts(effectiveModel)

      if (availableCcrAccounts.length === 0) {
        throw new Error(
          `No available CCR accounts support the requested model: ${effectiveModel || 'unspecified'}`
        )
      }

      // 3. 按优先级和最后使用时间排序
      const sortedAccounts = sortAccountsByPriority(availableCcrAccounts)
      const selectedAccount = sortedAccounts[0]

      // 4. 建立会话映射
      if (sessionHash) {
        await this._setSessionMapping(
          sessionHash,
          selectedAccount.accountId,
          selectedAccount.accountType
        )
        logger.info(
          `🎯 Created new sticky CCR session mapping: ${selectedAccount.name} (${selectedAccount.accountId}) for session ${sessionHash}`
        )
      }

      logger.info(
        `🎯 Selected CCR account: ${selectedAccount.name} (${selectedAccount.accountId}) with priority ${selectedAccount.priority} for API key ${apiKeyData.name}`
      )

      return {
        accountId: selectedAccount.accountId,
        accountType: selectedAccount.accountType
      }
    } catch (error) {
      logger.error('❌ Failed to select CCR account:', error)
      throw error
    }
  }

  // 📋 获取所有可用的CCR账户
  async _getAvailableCcrAccounts(requestedModel = null) {
    const availableAccounts = []

    try {
      const ccrAccounts = await ccrAccountService.getAllAccounts()
      logger.info(`📋 Found ${ccrAccounts.length} total CCR accounts for CCR-only selection`)

      for (const account of ccrAccounts) {
        logger.debug(
          `🔍 Checking CCR account: ${account.name} - isActive: ${account.isActive}, status: ${account.status}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
        )

        if (
          account.isActive === true &&
          account.status === 'active' &&
          account.accountType === 'shared' &&
          isSchedulable(account.schedulable)
        ) {
          // 检查模型支持
          if (!this._isModelSupportedByAccount(account, 'ccr', requestedModel)) {
            logger.debug(`CCR account ${account.name} does not support model ${requestedModel}`)
            continue
          }

          // 检查订阅是否过期
          if (ccrAccountService.isSubscriptionExpired(account)) {
            logger.debug(
              `⏰ CCR account ${account.name} (${account.id}) expired at ${account.subscriptionExpiresAt}`
            )
            continue
          }

          // 检查是否被限流或超额
          const isRateLimited = await ccrAccountService.isAccountRateLimited(account.id)
          const isQuotaExceeded = await ccrAccountService.isAccountQuotaExceeded(account.id)
          const isOverloaded = await ccrAccountService.isAccountOverloaded(account.id)

          if (!isRateLimited && !isQuotaExceeded && !isOverloaded) {
            availableAccounts.push({
              ...account,
              accountId: account.id,
              accountType: 'ccr',
              priority: parseInt(account.priority) || 50,
              lastUsedAt: account.lastUsedAt || '0'
            })
            logger.debug(`✅ Added CCR account to available pool: ${account.name}`)
          } else {
            logger.debug(
              `❌ CCR account ${account.name} not available - rateLimited: ${isRateLimited}, quotaExceeded: ${isQuotaExceeded}, overloaded: ${isOverloaded}`
            )
          }
        } else {
          logger.debug(
            `❌ CCR account ${account.name} not eligible - isActive: ${account.isActive}, status: ${account.status}, accountType: ${account.accountType}, schedulable: ${account.schedulable}`
          )
        }
      }

      logger.info(`📊 Total available CCR accounts: ${availableAccounts.length}`)
      return availableAccounts
    } catch (error) {
      logger.error('❌ Failed to get available CCR accounts:', error)
      return []
    }
  }

  /**
   * 🔒 检查 claude-official 账户是否可用于会话绑定
   * 注意：此方法仅用于 claude-official 类型账户，其他类型不受会话绑定限制
   * @param {string} accountId - 账户ID
   * @param {string} accountType - 账户类型（应为 'claude-official'）
   * @param {string} _requestedModel - 请求的模型（保留参数，当前未使用）
   * @returns {Promise<boolean>}
   */
  async _isAccountAvailableForSessionBinding(accountId, accountType, _requestedModel = null) {
    try {
      // 此方法仅处理 claude-official 类型
      if (accountType !== 'claude-official') {
        logger.warn(
          `Session binding: _isAccountAvailableForSessionBinding called for non-official type: ${accountType}`
        )
        return true // 非 claude-official 类型不受限制
      }

      const account = await redis.getClaudeAccount(accountId)
      if (!account) {
        logger.warn(`Session binding: Claude OAuth account ${accountId} not found`)
        return false
      }

      const isActive = account.isActive === 'true' || account.isActive === true
      const { status } = account

      if (!isActive) {
        logger.warn(`Session binding: Claude OAuth account ${accountId} is not active`)
        return false
      }

      if (status === 'error' || status === 'temp_error') {
        logger.warn(
          `Session binding: Claude OAuth account ${accountId} has error status: ${status}`
        )
        return false
      }

      // 检查是否被限流
      if (await claudeAccountService.isAccountRateLimited(accountId)) {
        logger.warn(`Session binding: Claude OAuth account ${accountId} is rate limited`)
        return false
      }

      // 检查临时不可用
      if (await this.isAccountTemporarilyUnavailable(accountId, accountType)) {
        logger.warn(`Session binding: Claude OAuth account ${accountId} is temporarily unavailable`)
        return false
      }

      return true
    } catch (error) {
      logger.error(
        `❌ Error checking account availability for session binding: ${accountId} (${accountType})`,
        error
      )
      return false
    }
  }
}

module.exports = new UnifiedClaudeScheduler()
