#!/usr/bin/env node

/**
 * 测试 Gemini token 刷新功能
 */

const path = require('path');
const dotenv = require('dotenv');

// 加载环境变量
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const redis = require('../src/models/redis');
const geminiAccountService = require('../src/services/geminiAccountService');
const logger = require('../src/utils/logger');

async function testGeminiTokenRefresh() {
  try {
    console.log('🚀 开始测试 Gemini token 刷新功能...\n');
    
    // 1. 连接 Redis
    console.log('📡 连接 Redis...');
    await redis.connect();
    console.log('✅ Redis 连接成功\n');
    
    // 2. 获取所有 Gemini 账户
    console.log('🔍 获取 Gemini 账户列表...');
    const accounts = await geminiAccountService.getAllAccounts();
    const geminiAccounts = accounts.filter(acc => acc.platform === 'gemini');
    
    if (geminiAccounts.length === 0) {
      console.log('❌ 没有找到 Gemini 账户');
      process.exit(1);
    }
    
    console.log(`✅ 找到 ${geminiAccounts.length} 个 Gemini 账户\n`);
    
    // 3. 测试每个账户的 token 刷新
    for (const account of geminiAccounts) {
      console.log(`\n📋 测试账户: ${account.name} (${account.id})`);
      console.log(`   状态: ${account.status}`);
      console.log(`   是否有 refresh token: ${account.refreshToken ? '是' : '否'}`);
      
      if (!account.refreshToken || account.refreshToken === '[ENCRYPTED]') {
        console.log('   ⚠️  跳过：无 refresh token\n');
        continue;
      }
      
      try {
        // 获取完整账户信息（包括解密的 token）
        const fullAccount = await geminiAccountService.getAccount(account.id);
        
        if (!fullAccount.refreshToken) {
          console.log('   ⚠️  跳过：无法获取 refresh token\n');
          continue;
        }
        
        console.log('   🔄 开始刷新 token...');
        const startTime = Date.now();
        
        // 执行 token 刷新
        const newTokens = await geminiAccountService.refreshAccountToken(account.id);
        
        const duration = Date.now() - startTime;
        console.log(`   ✅ Token 刷新成功！耗时: ${duration}ms`);
        console.log(`   📅 新的过期时间: ${new Date(newTokens.expiry_date).toLocaleString()}`);
        console.log(`   🔑 Access Token: ${newTokens.access_token.substring(0, 20)}...`);
        
        // 验证账户状态已更新
        const updatedAccount = await geminiAccountService.getAccount(account.id);
        console.log(`   📊 账户状态: ${updatedAccount.status}`);
        
      } catch (error) {
        console.log(`   ❌ Token 刷新失败: ${error.message}`);
        console.log(`   🔍 错误详情:`, error);
      }
    }
    
    console.log('\n✅ 测试完成！');
    
  } catch (error) {
    console.error('❌ 测试失败:', error);
  } finally {
    // 断开 Redis 连接
    await redis.disconnect();
    process.exit(0);
  }
}

// 运行测试
testGeminiTokenRefresh();