#!/usr/bin/env node

/**
 * LDAP User Validation Test Script
 *
 * This script demonstrates and tests the LDAP user validation mechanism.
 * It can be run manually or used for testing purposes.
 *
 * Usage:
 *   node scripts/test-ldap-validation.js [username]
 *
 * Examples:
 *   node scripts/test-ldap-validation.js                # Test all users
 *   node scripts/test-ldap-validation.js testuser       # Test specific user
 */

const path = require('path')
require('dotenv').config({ path: path.join(__dirname, '..', '.env') })

const config = require('../config/config')
const logger = require('../src/utils/logger')

// Set up test environment
logger.info('🧪 LDAP User Validation Test Script')
logger.info('====================================')

async function testLdapValidation(targetUsername = null) {
  try {
    // Check if LDAP is enabled
    if (!config.ldap || !config.ldap.enabled) {
      logger.warn('⚠️ LDAP is not enabled in configuration')
      logger.info('💡 To enable LDAP, set LDAP_ENABLED=true in your .env file')
      return
    }

    // Initialize services (normally done by app.js)
    const redis = require('../src/models/redis')
    await redis.connect()
    logger.info('✅ Connected to Redis')

    const ldapService = require('../src/services/ldapService')
    const userService = require('../src/services/userService')

    // Test LDAP connection first
    logger.info('🔍 Testing LDAP connection...')
    const connectionTest = await ldapService.testConnection()
    if (!connectionTest.success) {
      logger.error('❌ LDAP connection test failed:', connectionTest.message)
      return
    }
    logger.success('✅ LDAP connection test passed')

    let usersToTest = []

    if (targetUsername) {
      // Test specific user
      const user = await userService.getUserByUsername(targetUsername)
      if (!user) {
        logger.error(`❌ User "${targetUsername}" not found in local database`)
        return
      }
      usersToTest = [user]
      logger.info(`🎯 Testing specific user: ${targetUsername}`)
    } else {
      // Test all active users in a single scan
      const { users } = await userService.getAllUsers({
        isActive: true,
        page: 1,
        limit: Number.MAX_SAFE_INTEGER,
        includeUsageStats: false
      })
      usersToTest = users
      logger.info(`🔍 Testing ${usersToTest.length} active users`)
    }

    if (usersToTest.length === 0) {
      logger.info('📝 No users found to validate')
      return
    }

    logger.info('🔍 Starting LDAP user validation test...')
    logger.info('=====================================')

    let validatedCount = 0
    let notFoundCount = 0
    let errorCount = 0

    for (const user of usersToTest) {
      try {
        logger.info(`\n👤 Testing user: ${user.username} (${user.displayName || 'N/A'})`)

        const validationResult = await ldapService.validateUserInLdap(user.username)

        if (validationResult.exists) {
          logger.success(`  ✅ User exists in LDAP`)
          if (validationResult.userInfo) {
            logger.info(`  📋 User info:`, {
              displayName: validationResult.userInfo.displayName,
              email: validationResult.userInfo.email,
              firstName: validationResult.userInfo.firstName,
              lastName: validationResult.userInfo.lastName
            })
          }
          validatedCount++
        } else {
          logger.warn(`  🚫 User NOT found in LDAP: ${validationResult.message}`)
          logger.warn(`  ⚠️  In production, this user would be deactivated`)
          notFoundCount++
        }
      } catch (error) {
        logger.error(`  ❌ Validation error: ${error.message}`)
        errorCount++
      }
    }

    logger.info('\n📊 Test Results Summary')
    logger.info('=======================')
    logger.info(`Total users tested: ${usersToTest.length}`)
    logger.success(`✅ Valid in LDAP: ${validatedCount}`)
    logger.warn(`🚫 Not found in LDAP: ${notFoundCount}`)
    logger.error(`❌ Validation errors: ${errorCount}`)

    if (notFoundCount > 0) {
      logger.info('\n💡 Users not found in LDAP would be deactivated in production')
    }
  } catch (error) {
    logger.error('❌ Test script failed:', {
      error: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    })
  } finally {
    // Clean up
    try {
      const redis = require('../src/models/redis')
      await redis.disconnect()
      logger.info('👋 Disconnected from Redis')
    } catch (error) {
      logger.debug('Redis disconnect error:', error)
    }
  }
}

// Parse command line arguments
const targetUsername = process.argv[2]

// Run the test
testLdapValidation(targetUsername)
  .then(() => {
    logger.info('🏁 Test completed')
    process.exit(0)
  })
  .catch((error) => {
    logger.error('💥 Test failed:', error)
    process.exit(1)
  })
