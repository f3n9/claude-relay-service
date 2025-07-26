#!/usr/bin/env node

/**
 * 手动更新 Gemini 账户的 refresh token
 */

const path = require('path');
const dotenv = require('dotenv');

// 加载环境变量
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const redis = require('../src/models/redis');
const geminiAccountService = require('../src/services/geminiAccountService');
const logger = require('../src/utils/logger');

async function updateGeminiRefreshToken() {
  const accountId = process.argv[2];
  const refreshToken = process.argv[3];
  
  if (!accountId || !refreshToken) {
    console.log('❌ 用法: node scripts/update-gemini-token.js <accountId> <refreshToken>');
    console.log('\n示例:');
    console.log('node scripts/update-gemini-token.js 16befd10-9691-43d8-8a8a-39b6fd83dbc0 "1//0gEXAMPLE..."');
    process.exit(1);
  }
  
  try {
    console.log('🚀 开始更新 Gemini refresh token...\n');
    
    // 连接 Redis
    console.log('📡 连接 Redis...');
    await redis.connect();
    console.log('✅ Redis 连接成功\n');
    
    // 获取账户
    const account = await geminiAccountService.getAccount(accountId);
    if (!account) {
      console.log(`❌ 未找到账户: ${accountId}`);
      process.exit(1);
    }
    
    console.log(`📋 找到账户: ${account.name} (${accountId})`);
    console.log(`   当前状态: ${account.status}`);
    
    // 更新 refresh token
    console.log('\n🔄 更新 refresh token...');
    await geminiAccountService.updateAccount(accountId, {
      refreshToken: refreshToken,
      status: 'active',
      errorMessage: ''
    });
    
    console.log('✅ Refresh token 已更新！');
    
    // 立即尝试刷新 token
    console.log('\n🔄 尝试刷新 access token...');
    try {
      const newTokens = await geminiAccountService.refreshAccountToken(accountId);
      console.log('✅ Token 刷新成功！');
      console.log(`   Access Token 前缀: ${newTokens.access_token.substring(0, 20)}...`);
      console.log(`   过期时间: ${new Date(newTokens.expiry_date).toLocaleString()}`);
    } catch (error) {
      console.log(`❌ Token 刷新失败: ${error.message}`);
      console.log('   请检查 refresh token 是否有效');
    }
    
  } catch (error) {
    console.error('❌ 更新失败:', error);
  } finally {
    await redis.disconnect();
    process.exit(0);
  }
}

// 运行更新
updateGeminiRefreshToken();