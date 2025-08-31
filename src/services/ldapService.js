const ldap = require('ldapjs')
const logger = require('../utils/logger')
const config = require('../../config/config')
const userService = require('./userService')

class LdapService {
  constructor() {
    this.config = config.ldap
    this.client = null

    // 验证配置
    if (this.config.enabled) {
      this.validateConfiguration()
    }
  }

  // 🔍 验证LDAP配置
  validateConfiguration() {
    const errors = []

    if (!this.config.server) {
      errors.push('LDAP server configuration is missing')
    } else {
      if (!this.config.server.url || typeof this.config.server.url !== 'string') {
        errors.push('LDAP server URL is not configured or invalid')
      }

      if (!this.config.server.bindDN || typeof this.config.server.bindDN !== 'string') {
        errors.push('LDAP bind DN is not configured or invalid')
      }

      if (
        !this.config.server.bindCredentials ||
        typeof this.config.server.bindCredentials !== 'string'
      ) {
        errors.push('LDAP bind credentials are not configured or invalid')
      }

      if (!this.config.server.searchBase || typeof this.config.server.searchBase !== 'string') {
        errors.push('LDAP search base is not configured or invalid')
      }

      if (!this.config.server.searchFilter || typeof this.config.server.searchFilter !== 'string') {
        errors.push('LDAP search filter is not configured or invalid')
      }
    }

    if (errors.length > 0) {
      logger.error('❌ LDAP configuration validation failed:', errors)
      // Don't throw error during initialization, just log warnings
      logger.warn('⚠️ LDAP authentication may not work properly due to configuration errors')
    } else {
      logger.info('✅ LDAP configuration validation passed')
    }
  }

  // 🔍 提取LDAP条目的DN
  extractDN(ldapEntry) {
    if (!ldapEntry) {
      return null
    }

    // Try different ways to get the DN
    let dn = null

    // Method 1: Direct dn property
    if (ldapEntry.dn) {
      ;({ dn } = ldapEntry)
    }
    // Method 2: objectName property (common in some LDAP implementations)
    else if (ldapEntry.objectName) {
      dn = ldapEntry.objectName
    }
    // Method 3: distinguishedName property
    else if (ldapEntry.distinguishedName) {
      dn = ldapEntry.distinguishedName
    }
    // Method 4: Check if the entry itself is a DN string
    else if (typeof ldapEntry === 'string' && ldapEntry.includes('=')) {
      dn = ldapEntry
    }

    // Convert DN to string if it's an object
    if (dn && typeof dn === 'object') {
      if (dn.toString && typeof dn.toString === 'function') {
        dn = dn.toString()
      } else if (dn.dn && typeof dn.dn === 'string') {
        ;({ dn } = dn)
      }
    }

    // Validate the DN format
    if (typeof dn === 'string' && dn.trim() !== '' && dn.includes('=')) {
      return dn.trim()
    }

    return null
  }

  // 🔗 创建LDAP客户端连接
  createClient() {
    try {
      const clientOptions = {
        url: this.config.server.url,
        timeout: this.config.server.timeout,
        connectTimeout: this.config.server.connectTimeout,
        reconnect: true
      }

      // 如果使用 LDAPS (SSL/TLS)，添加 TLS 选项
      if (this.config.server.url.toLowerCase().startsWith('ldaps://')) {
        const tlsOptions = {}

        // 证书验证设置
        if (this.config.server.tls) {
          if (typeof this.config.server.tls.rejectUnauthorized === 'boolean') {
            tlsOptions.rejectUnauthorized = this.config.server.tls.rejectUnauthorized
          }

          // CA 证书
          if (this.config.server.tls.ca) {
            tlsOptions.ca = this.config.server.tls.ca
          }

          // 客户端证书和私钥 (双向认证)
          if (this.config.server.tls.cert) {
            tlsOptions.cert = this.config.server.tls.cert
          }

          if (this.config.server.tls.key) {
            tlsOptions.key = this.config.server.tls.key
          }

          // 服务器名称 (SNI)
          if (this.config.server.tls.servername) {
            tlsOptions.servername = this.config.server.tls.servername
          }
        }

        clientOptions.tlsOptions = tlsOptions

        logger.debug('🔒 Creating LDAPS client with TLS options:', {
          url: this.config.server.url,
          rejectUnauthorized: tlsOptions.rejectUnauthorized,
          hasCA: !!tlsOptions.ca,
          hasCert: !!tlsOptions.cert,
          hasKey: !!tlsOptions.key,
          servername: tlsOptions.servername
        })
      }

      const client = ldap.createClient(clientOptions)

      // 设置错误处理
      client.on('error', (err) => {
        if (err.code === 'CERT_HAS_EXPIRED' || err.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
          logger.error('🔒 LDAP TLS certificate error:', {
            code: err.code,
            message: err.message,
            hint: 'Consider setting LDAP_TLS_REJECT_UNAUTHORIZED=false for self-signed certificates'
          })
        } else {
          logger.error('🔌 LDAP client error:', err)
        }
      })

      client.on('connect', () => {
        if (this.config.server.url.toLowerCase().startsWith('ldaps://')) {
          logger.info('🔒 LDAPS client connected successfully')
        } else {
          logger.info('🔗 LDAP client connected successfully')
        }
      })

      client.on('connectTimeout', () => {
        logger.warn('⏱️ LDAP connection timeout')
      })

      return client
    } catch (error) {
      logger.error('❌ Failed to create LDAP client:', error)
      throw error
    }
  }

  // 🔒 绑定LDAP连接（管理员认证）
  async bindClient(client) {
    return new Promise((resolve, reject) => {
      // 验证绑定凭据
      const { bindDN } = this.config.server
      const { bindCredentials } = this.config.server

      if (!bindDN || typeof bindDN !== 'string') {
        const error = new Error('LDAP bind DN is not configured or invalid')
        logger.error('❌ LDAP configuration error:', error.message)
        reject(error)
        return
      }

      if (!bindCredentials || typeof bindCredentials !== 'string') {
        const error = new Error('LDAP bind credentials are not configured or invalid')
        logger.error('❌ LDAP configuration error:', error.message)
        reject(error)
        return
      }

      client.bind(bindDN, bindCredentials, (err) => {
        if (err) {
          logger.error('❌ LDAP bind failed:', err)
          reject(err)
        } else {
          logger.debug('🔑 LDAP bind successful')
          resolve()
        }
      })
    })
  }

  // 🔍 搜索用户 - 使用安全的过滤器构造
  async searchUser(client, username) {
    return new Promise((resolve, reject) => {
      // 确保用户名经过验证和清理
      let sanitizedUsername
      try {
        sanitizedUsername = this.validateAndSanitizeUsername(username)
      } catch (error) {
        logger.error('❌ Username validation failed:', error.message)
        reject(error)
        return
      }

      // 使用参数化方式构造LDAP过滤器，而不是字符串替换
      const searchFilter = this.config.server.searchFilter.replace(
        '{{username}}',
        sanitizedUsername
      )

      // 验证最终的过滤器字符串
      if (!searchFilter.includes(sanitizedUsername)) {
        logger.error('❌ LDAP filter construction failed - sanitized username not found in filter')
        reject(new Error('Internal error: LDAP filter construction failed'))
        return
      }

      const searchOptions = {
        scope: 'sub',
        filter: searchFilter,
        attributes: this.config.server.searchAttributes
      }

      logger.debug(`🔍 Searching for user: ${sanitizedUsername} with filter: ${searchFilter}`)

      const entries = []

      client.search(this.config.server.searchBase, searchOptions, (err, res) => {
        if (err) {
          logger.error('❌ LDAP search error:', err)
          reject(err)
          return
        }

        res.on('searchEntry', (entry) => {
          logger.debug('🔍 LDAP search entry received:', {
            dn: entry.dn,
            objectName: entry.objectName,
            type: typeof entry.dn,
            entryType: typeof entry,
            hasAttributes: !!entry.attributes,
            attributeCount: entry.attributes ? entry.attributes.length : 0
          })
          entries.push(entry)
        })

        res.on('searchReference', (referral) => {
          logger.debug('🔗 LDAP search referral:', referral.uris)
        })

        res.on('error', (error) => {
          logger.error('❌ LDAP search result error:', error)
          reject(error)
        })

        res.on('end', (result) => {
          logger.debug(
            `✅ LDAP search completed. Status: ${result.status}, Found ${entries.length} entries`
          )

          if (entries.length === 0) {
            resolve(null)
          } else {
            // Log the structure of the first entry for debugging
            if (entries[0]) {
              logger.debug('🔍 Full LDAP entry structure:', {
                entryType: typeof entries[0],
                entryConstructor: entries[0].constructor?.name,
                entryKeys: Object.keys(entries[0]),
                entryStringified: JSON.stringify(entries[0], null, 2).substring(0, 500)
              })
            }

            if (entries.length === 1) {
              resolve(entries[0])
            } else {
              logger.warn(`⚠️ Multiple LDAP entries found for username: ${sanitizedUsername}`)
              resolve(entries[0]) // 使用第一个结果
            }
          }
        })
      })
    })
  }

  // 🔐 验证用户密码
  async authenticateUser(userDN, password) {
    return new Promise((resolve, reject) => {
      // 验证输入参数
      if (!userDN || typeof userDN !== 'string') {
        const error = new Error('User DN is not provided or invalid')
        logger.error('❌ LDAP authentication error:', error.message)
        reject(error)
        return
      }

      if (!password || typeof password !== 'string') {
        logger.debug(`🚫 Invalid or empty password for DN: ${userDN}`)
        resolve(false)
        return
      }

      const authClient = this.createClient()

      authClient.bind(userDN, password, (err) => {
        authClient.unbind() // 立即关闭认证客户端

        if (err) {
          if (err.name === 'InvalidCredentialsError') {
            logger.debug(`🚫 Invalid credentials for DN: ${userDN}`)
            resolve(false)
          } else {
            logger.error('❌ LDAP authentication error:', err)
            reject(err)
          }
        } else {
          logger.debug(`✅ Authentication successful for DN: ${userDN}`)
          resolve(true)
        }
      })
    })
  }

  // 📝 提取用户信息
  extractUserInfo(ldapEntry, username) {
    try {
      const attributes = ldapEntry.attributes || []
      const userInfo = { username }

      // 创建属性映射
      const attrMap = {}
      attributes.forEach((attr) => {
        const name = attr.type || attr.name
        const values = Array.isArray(attr.values) ? attr.values : [attr.values]
        attrMap[name] = values.length === 1 ? values[0] : values
      })

      // 根据配置映射用户属性
      const mapping = this.config.userMapping

      userInfo.displayName = attrMap[mapping.displayName] || username
      userInfo.email = attrMap[mapping.email] || ''
      userInfo.firstName = attrMap[mapping.firstName] || ''
      userInfo.lastName = attrMap[mapping.lastName] || ''

      // 如果没有displayName，尝试组合firstName和lastName
      if (!userInfo.displayName || userInfo.displayName === username) {
        if (userInfo.firstName || userInfo.lastName) {
          userInfo.displayName = `${userInfo.firstName || ''} ${userInfo.lastName || ''}`.trim()
        }
      }

      logger.debug('📋 Extracted user info:', {
        username: userInfo.username,
        displayName: userInfo.displayName,
        email: userInfo.email
      })

      return userInfo
    } catch (error) {
      logger.error('❌ Error extracting user info:', error)
      return { username }
    }
  }

  // 🔒 LDAP特殊字符转义 (RFC 4515)
  escapeLdapFilter(input) {
    if (!input || typeof input !== 'string') {
      return ''
    }

    // 转义LDAP过滤器中的特殊字符 (RFC 4515)
    return input
      .replace(/\\/g, '\\5c') // \ -> \5c
      .replace(/\*/g, '\\2a') // * -> \2a
      .replace(/\(/g, '\\28') // ( -> \28
      .replace(/\)/g, '\\29') // ) -> \29
      .replace(/\0/g, '\\00') // NULL -> \00
  }

  // 🔍 验证和清理用户名 - 增强LDAP注入防护和Unicode安全
  validateAndSanitizeUsername(username) {
    if (!username || typeof username !== 'string' || username.trim() === '') {
      throw new Error('Username is required and must be a non-empty string')
    }

    const trimmedUsername = username.trim()

    // 🔒 Unicode安全处理
    // 1. Unicode规范化 - 防止使用等价字符绕过验证
    let normalizedUsername = trimmedUsername.normalize('NFKC') // 兼容性规范化

    // 2. 移除零宽度字符和其他不可见字符（可能用于绕过检测）
    const invisibleCharPattern =
      /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\u00AD]/g
    normalizedUsername = normalizedUsername.replace(invisibleCharPattern, '')

    // 3. 检测和拒绝同形异义字符（homoglyphs）- 防止视觉欺骗攻击
    const suspiciousHomoglyphs = [
      /[\u0430\u043E\u0440]/g, // 西里尔字母 а, о, р (看起来像拉丁字母)
      /[\u03B1\u03BF\u03C1]/g, // 希腊字母 α, ο, ρ
      /[\u0561\u043E\u0440]/g, // 亚美尼亚字母
      /[\uFF41-\uFF5A]/g, // 全角拉丁字母
      /[\u2460-\u2473]/g // 带圈数字
    ]

    for (const pattern of suspiciousHomoglyphs) {
      if (pattern.test(normalizedUsername)) {
        logger.security(`🚨 Homoglyph characters detected in username: ${trimmedUsername}`)
        throw new Error(
          'Username contains visually deceptive characters. Please use standard ASCII characters only.'
        )
      }
    }

    // 4. 检查控制字符和格式字符 - 使用字符类避免ESLint警告
    const hasControlChars = (str) => {
      // 检查C0控制字符 (U+0000 to U+001F)
      for (let i = 0; i <= 0x1f; i++) {
        if (str.includes(String.fromCharCode(i))) {
          return true
        }
      }
      // 检查DEL和C1控制字符 (U+007F to U+009F)
      for (let i = 0x7f; i <= 0x9f; i++) {
        if (str.includes(String.fromCharCode(i))) {
          return true
        }
      }
      // 检查其他格式字符
      const formatChars = /[\u2000-\u200F\u2028-\u202F]/
      return formatChars.test(str)
    }

    if (hasControlChars(normalizedUsername)) {
      logger.security(`🚨 Control characters detected in username: ${trimmedUsername}`)
      throw new Error('Username contains invalid control characters')
    }

    // 🔒 LDAP注入防护增强
    // 检查是否包含LDAP注入攻击特征
    const ldapInjectionPatterns = [
      /[()&|!]/, // LDAP逻辑操作符
      /\\[0-9a-fA-F]{2}/, // 十六进制转义序列
      /\*(?!\s*$)/, // 通配符(除了末尾的单独*)
      /[<>=~]/, // 比较操作符
      /;\s*(objectClass|cn|uid|mail|ou)=/i, // 可能的注入尝试
      null, // NULL字节检查已在hasControlChars中处理
      /[\r\n]/, // 换行字符（可能的注入）
      /\${.*}/, // 变量替换模式
      /@.*@/, // 邮箱格式但在用户名上下文中可疑
      /\.\./, // 目录遍历模式
      /['"]/ // 引号字符
    ]

    for (const pattern of ldapInjectionPatterns) {
      if (pattern && pattern.test(normalizedUsername)) {
        logger.security(`🚨 LDAP injection attempt detected: ${trimmedUsername}`)
        throw new Error(
          'Username contains invalid characters that could lead to security vulnerabilities'
        )
      }
    }

    // 🔒 字符集限制 - 只允许安全字符
    // 扩展的安全字符集：字母、数字、基本标点
    const safeCharPattern = /^[a-zA-Z0-9._@-]+$/
    if (!safeCharPattern.test(normalizedUsername)) {
      // 为了更好的用户体验，提供更具体的错误信息
      const hasInternational = /[^\x20-\x7E]/.test(normalizedUsername)
      const hasSpecialChars = /[^a-zA-Z0-9._@-]/.test(
        normalizedUsername.replace(/[^\x20-\x7E]/g, '')
      )

      let errorMsg =
        'Username can only contain letters, numbers, periods, underscores, @ symbols, and hyphens'
      if (hasInternational) {
        errorMsg += '. International characters are not supported for security reasons'
      }
      if (hasSpecialChars) {
        errorMsg += '. Special characters are not allowed'
      }

      throw new Error(errorMsg)
    }

    // 🔒 长度和格式验证
    // 长度限制 (防止过长的输入和潜在的DoS攻击)
    if (normalizedUsername.length > 128) {
      // 增加最大长度到128以支持邮箱格式
      throw new Error('Username cannot exceed 128 characters')
    }

    if (normalizedUsername.length < 2) {
      // 最小长度限制
      throw new Error('Username must be at least 2 characters long')
    }

    // 不能以特殊字符开头或结尾（除了@符号支持邮箱格式）
    if (/^[-.]/.test(normalizedUsername) || /[-.]$/.test(normalizedUsername)) {
      throw new Error('Username cannot start or end with a hyphen or period')
    }

    // 🔒 邮箱格式特殊验证（如果包含@）
    if (normalizedUsername.includes('@')) {
      const emailPattern = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/
      if (!emailPattern.test(normalizedUsername)) {
        throw new Error('If username contains @, it must be a valid email format')
      }

      // 检查邮箱中的可疑模式
      const suspiciousEmailPatterns = [
        /\.{2,}/, // 连续多个点
        /@{2,}/, // 多个@符号
        /[._-]{3,}/ // 连续多个特殊字符
      ]

      for (const pattern of suspiciousEmailPatterns) {
        if (pattern.test(normalizedUsername)) {
          throw new Error('Email format username contains suspicious patterns')
        }
      }
    }

    // 🔒 最终的LDAP过滤器转义作为深度防护
    const escapedUsername = this.escapeLdapFilter(normalizedUsername)

    // 验证转义后的用户名
    if (escapedUsername !== normalizedUsername) {
      logger.info(
        `🔒 LDAP escaping applied to username: ${normalizedUsername} -> ${escapedUsername}`
      )
    }

    // 🔍 记录用户名验证成功（用于审计）
    logger.debug(`✅ Username validation successful: ${escapedUsername}`)

    return escapedUsername
  }

  // 🔐 主要的登录验证方法
  async authenticateUserCredentials(username, password) {
    if (!this.config.enabled) {
      throw new Error('LDAP authentication is not enabled')
    }

    // 验证和清理用户名 (防止LDAP注入)
    const sanitizedUsername = this.validateAndSanitizeUsername(username)

    if (!password || typeof password !== 'string' || password.trim() === '') {
      throw new Error('Password is required and must be a non-empty string')
    }

    // 验证LDAP服务器配置
    if (!this.config.server || !this.config.server.url) {
      throw new Error('LDAP server URL is not configured')
    }

    if (!this.config.server.bindDN || typeof this.config.server.bindDN !== 'string') {
      throw new Error('LDAP bind DN is not configured')
    }

    if (
      !this.config.server.bindCredentials ||
      typeof this.config.server.bindCredentials !== 'string'
    ) {
      throw new Error('LDAP bind credentials are not configured')
    }

    if (!this.config.server.searchBase || typeof this.config.server.searchBase !== 'string') {
      throw new Error('LDAP search base is not configured')
    }

    const client = this.createClient()

    try {
      // 1. 使用管理员凭据绑定
      await this.bindClient(client)

      // 2. 搜索用户 (使用已验证的用户名)
      const ldapEntry = await this.searchUser(client, sanitizedUsername)
      if (!ldapEntry) {
        logger.info(`🚫 User not found in LDAP: ${sanitizedUsername}`)
        return { success: false, message: 'Invalid username or password' }
      }

      // 3. 获取用户DN
      logger.debug('🔍 LDAP entry details for DN extraction:', {
        hasEntry: !!ldapEntry,
        entryType: typeof ldapEntry,
        entryKeys: Object.keys(ldapEntry || {}),
        dn: ldapEntry.dn,
        objectName: ldapEntry.objectName,
        dnType: typeof ldapEntry.dn,
        objectNameType: typeof ldapEntry.objectName
      })

      // Use the helper method to extract DN
      const userDN = this.extractDN(ldapEntry)

      logger.debug(`👤 Extracted user DN: ${userDN} (type: ${typeof userDN})`)

      // 验证用户DN
      if (!userDN) {
        logger.error(`❌ Invalid or missing DN for user: ${sanitizedUsername}`, {
          ldapEntryDn: ldapEntry.dn,
          ldapEntryObjectName: ldapEntry.objectName,
          ldapEntryType: typeof ldapEntry,
          extractedDN: userDN
        })
        return { success: false, message: 'Authentication service error' }
      }

      // 4. 验证用户密码
      const isPasswordValid = await this.authenticateUser(userDN, password)
      if (!isPasswordValid) {
        logger.info(`🚫 Invalid password for user: ${sanitizedUsername}`)
        return { success: false, message: 'Invalid username or password' }
      }

      // 5. 提取用户信息
      const userInfo = this.extractUserInfo(ldapEntry, sanitizedUsername)

      // 6. 创建或更新本地用户
      const user = await userService.createOrUpdateUser(userInfo)

      // 7. 检查用户是否被禁用
      if (!user.isActive) {
        logger.security(
          `🔒 Disabled user LDAP login attempt: ${sanitizedUsername} from LDAP authentication`
        )
        return {
          success: false,
          message: 'Your account has been disabled. Please contact administrator.'
        }
      }

      // 8. 记录登录
      await userService.recordUserLogin(user.id)

      // 9. 创建用户会话
      const sessionToken = await userService.createUserSession(user.id)

      logger.info(`✅ LDAP authentication successful for user: ${sanitizedUsername}`)

      return {
        success: true,
        user,
        sessionToken,
        message: 'Authentication successful'
      }
    } catch (error) {
      logger.error('❌ LDAP authentication error:', error)
      return {
        success: false,
        message: 'Authentication service unavailable'
      }
    } finally {
      // 确保客户端连接被关闭
      if (client) {
        client.unbind((err) => {
          if (err) {
            logger.debug('Error unbinding LDAP client:', err)
          }
        })
      }
    }
  }

  // 🔍 测试LDAP连接
  async testConnection() {
    if (!this.config.enabled) {
      return { success: false, message: 'LDAP is not enabled' }
    }

    const client = this.createClient()

    try {
      await this.bindClient(client)

      return {
        success: true,
        message: 'LDAP connection successful',
        server: this.config.server.url,
        searchBase: this.config.server.searchBase
      }
    } catch (error) {
      logger.error('❌ LDAP connection test failed:', error)
      return {
        success: false,
        message: `LDAP connection failed: ${error.message}`,
        server: this.config.server.url
      }
    } finally {
      if (client) {
        client.unbind((err) => {
          if (err) {
            logger.debug('Error unbinding test LDAP client:', err)
          }
        })
      }
    }
  }

  // 📊 获取LDAP配置信息（不包含敏感信息）
  getConfigInfo() {
    const configInfo = {
      enabled: this.config.enabled,
      server: {
        url: this.config.server.url,
        searchBase: this.config.server.searchBase,
        searchFilter: this.config.server.searchFilter,
        timeout: this.config.server.timeout,
        connectTimeout: this.config.server.connectTimeout
      },
      userMapping: this.config.userMapping
    }

    // 添加 TLS 配置信息（不包含敏感数据）
    if (this.config.server.url.toLowerCase().startsWith('ldaps://') && this.config.server.tls) {
      configInfo.server.tls = {
        rejectUnauthorized: this.config.server.tls.rejectUnauthorized,
        hasCA: !!this.config.server.tls.ca,
        hasCert: !!this.config.server.tls.cert,
        hasKey: !!this.config.server.tls.key,
        servername: this.config.server.tls.servername
      }
    }

    return configInfo
  }
}

module.exports = new LdapService()
