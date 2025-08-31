const logger = require('./logger')
const crypto = require('crypto')
const os = require('os')

/**
 * 安全审计日志系统
 * 用于记录所有安全相关事件和潜在的安全威胁
 *
 * 事件类型：
 * - AUTHENTICATION: 认证相关事件
 * - AUTHORIZATION: 授权相关事件
 * - INJECTION_ATTEMPT: 注入攻击尝试
 * - RATE_LIMIT: 速率限制触发
 * - SUSPICIOUS_ACTIVITY: 可疑活动
 * - SECURITY_VIOLATION: 安全策略违反
 * - DATA_ACCESS: 敏感数据访问
 * - SYSTEM_SECURITY: 系统安全事件
 */

class SecurityAuditLogger {
  constructor() {
    this.sessionId = crypto.randomBytes(16).toString('hex')
    this.hostname = os.hostname()
    this.pid = process.pid
  }

  /**
   * 生成安全事件的唯一标识符
   */
  generateEventId() {
    return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`
  }

  /**
   * 获取客户端IP地址（支持代理）
   */
  getClientIP(req) {
    return (
      req.get('x-forwarded-for') ||
      req.get('x-real-ip') ||
      req.connection.remoteAddress ||
      req.socket.remoteAddress ||
      (req.connection.socket ? req.connection.socket.remoteAddress : null) ||
      'unknown'
    )
  }

  /**
   * 获取用户代理信息
   */
  getUserAgent(req) {
    return req.get('user-agent') || 'unknown'
  }

  /**
   * 创建基础审计事件对象
   */
  createBaseEvent(eventType, severity, req = null) {
    const event = {
      eventId: this.generateEventId(),
      timestamp: new Date().toISOString(),
      eventType,
      severity, // CRITICAL, HIGH, MEDIUM, LOW, INFO
      sessionId: this.sessionId,
      hostname: this.hostname,
      pid: this.pid,
      environment: process.env.NODE_ENV || 'development'
    }

    if (req) {
      event.request = {
        method: req.method,
        url: req.url,
        path: req.path,
        clientIP: this.getClientIP(req),
        userAgent: this.getUserAgent(req),
        referer: req.get('referer') || null,
        origin: req.get('origin') || null,
        contentType: req.get('content-type') || null,
        contentLength: req.get('content-length') || null
      }

      // 记录认证信息（如果存在）
      if (req.apiKey) {
        event.authentication = {
          apiKeyId: req.apiKey.id,
          apiKeyName: req.apiKey.name,
          userId: req.user?.id || null
        }
      }
    }

    return event
  }

  /**
   * 记录认证事件
   */
  logAuthentication(action, result, req, details = {}) {
    const event = this.createBaseEvent(
      'AUTHENTICATION',
      result === 'SUCCESS' ? 'INFO' : 'HIGH',
      req
    )

    event.authentication = {
      action, // LOGIN, LOGOUT, TOKEN_REFRESH, API_KEY_AUTH, etc.
      result, // SUCCESS, FAILURE, BLOCKED, EXPIRED, etc.
      ...details
    }

    logger.security('Authentication event', event)
    return event.eventId
  }

  /**
   * 记录授权事件
   */
  logAuthorization(resource, action, result, req, details = {}) {
    const event = this.createBaseEvent('AUTHORIZATION', result === 'GRANTED' ? 'INFO' : 'HIGH', req)

    event.authorization = {
      resource,
      action,
      result, // GRANTED, DENIED, INSUFFICIENT_PRIVILEGES
      ...details
    }

    logger.security('Authorization event', event)
    return event.eventId
  }

  /**
   * 记录注入攻击尝试
   */
  logInjectionAttempt(injectionType, payload, req, details = {}) {
    const event = this.createBaseEvent('INJECTION_ATTEMPT', 'CRITICAL', req)

    event.injection = {
      type: injectionType, // SQL, LDAP, XSS, COMMAND, etc.
      payload: payload.substring(0, 1000), // 限制载荷长度
      payloadLength: payload.length,
      blocked: true,
      ...details
    }

    logger.security('Injection attack attempt detected', event)
    return event.eventId
  }

  /**
   * 记录速率限制事件
   */
  logRateLimit(limitType, limit, current, req, details = {}) {
    const event = this.createBaseEvent('RATE_LIMIT', 'MEDIUM', req)

    event.rateLimit = {
      type: limitType, // API_KEY, IP, USER, GLOBAL
      limit,
      current,
      exceeded: current > limit,
      ...details
    }

    logger.security('Rate limit triggered', event)
    return event.eventId
  }

  /**
   * 记录可疑活动
   */
  logSuspiciousActivity(activityType, description, req, details = {}) {
    const event = this.createBaseEvent('SUSPICIOUS_ACTIVITY', 'HIGH', req)

    event.suspicious = {
      type: activityType, // BRUTE_FORCE, ENUMERATION, ANOMALY, etc.
      description,
      ...details
    }

    logger.security('Suspicious activity detected', event)
    return event.eventId
  }

  /**
   * 记录安全策略违反
   */
  logSecurityViolation(violationType, policy, action, req, details = {}) {
    const event = this.createBaseEvent('SECURITY_VIOLATION', 'HIGH', req)

    event.violation = {
      type: violationType, // CSP_VIOLATION, CORS_VIOLATION, etc.
      policy,
      action, // BLOCKED, LOGGED, WARNED
      ...details
    }

    logger.security('Security policy violation', event)
    return event.eventId
  }

  /**
   * 记录敏感数据访问
   */
  logDataAccess(dataType, operation, result, req, details = {}) {
    const event = this.createBaseEvent('DATA_ACCESS', 'INFO', req)

    event.dataAccess = {
      dataType, // API_KEY, ACCOUNT, USER_DATA, etc.
      operation, // CREATE, READ, UPDATE, DELETE, EXPORT, IMPORT
      result, // SUCCESS, FAILURE, PARTIAL
      recordCount: details.recordCount || 1,
      ...details
    }

    logger.audit('Sensitive data access', event)
    return event.eventId
  }

  /**
   * 记录系统安全事件
   */
  logSystemSecurity(eventType, description, severity = 'MEDIUM', details = {}) {
    const event = this.createBaseEvent('SYSTEM_SECURITY', severity)

    event.system = {
      type: eventType, // CONFIG_CHANGE, SERVICE_START, SERVICE_STOP, etc.
      description,
      ...details
    }

    logger.security('System security event', event)
    return event.eventId
  }

  /**
   * 记录账户锁定事件
   */
  logAccountLockout(accountType, identifier, reason, req, details = {}) {
    const event = this.createBaseEvent('AUTHENTICATION', 'HIGH', req)

    event.lockout = {
      accountType, // USER, API_KEY, ADMIN
      identifier,
      reason, // FAILED_ATTEMPTS, SECURITY_POLICY, ADMIN_ACTION
      duration: details.duration || null,
      ...details
    }

    logger.security('Account lockout event', event)
    return event.eventId
  }

  /**
   * 记录数据导出/导入事件
   */
  logDataTransfer(operation, dataTypes, result, req, details = {}) {
    const event = this.createBaseEvent('DATA_ACCESS', 'HIGH', req)

    event.dataTransfer = {
      operation, // EXPORT, IMPORT
      dataTypes, // ['API_KEYS', 'ACCOUNTS', 'USERS']
      result, // SUCCESS, FAILURE, PARTIAL
      recordCount: details.recordCount || 0,
      sanitized: details.sanitized || false,
      encrypted: details.encrypted || false,
      filePath: details.filePath || null,
      ...details
    }

    logger.audit('Data transfer operation', event)
    return event.eventId
  }

  /**
   * 记录配置更改事件
   */
  logConfigurationChange(configType, changes, req, details = {}) {
    const event = this.createBaseEvent('SYSTEM_SECURITY', 'MEDIUM', req)

    event.configuration = {
      type: configType, // SECURITY, RATE_LIMIT, CORS, etc.
      changes, // Array of changed settings
      ...details
    }

    logger.audit('Configuration change', event)
    return event.eventId
  }

  /**
   * 批量记录安全事件（用于模式检测）
   */
  logSecurityPattern(patternType, events, severity, details = {}) {
    const event = this.createBaseEvent('SUSPICIOUS_ACTIVITY', severity)

    event.pattern = {
      type: patternType, // BRUTE_FORCE_PATTERN, DDoS_PATTERN, etc.
      eventCount: events.length,
      timeWindow: details.timeWindow || null,
      threshold: details.threshold || null,
      events: events.slice(0, 10), // 只记录前10个事件避免日志过大
      ...details
    }

    logger.security('Security pattern detected', event)
    return event.eventId
  }

  /**
   * 记录加密操作事件
   */
  logEncryptionEvent(operation, dataType, result, details = {}) {
    const event = this.createBaseEvent('SYSTEM_SECURITY', 'INFO')

    event.encryption = {
      operation, // ENCRYPT, DECRYPT, KEY_ROTATION
      dataType, // PASSWORD, TOKEN, OAUTH_DATA, etc.
      result, // SUCCESS, FAILURE
      algorithm: details.algorithm || 'AES-256-CBC',
      ...details
    }

    logger.security('Encryption operation', event)
    return event.eventId
  }
}

// 创建单例实例
const securityAudit = new SecurityAuditLogger()

// 导出单例和类
module.exports = {
  SecurityAuditLogger,
  securityAudit
}
