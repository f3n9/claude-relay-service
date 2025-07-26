#!/usr/bin/env node

/**
 * 调试 Gemini refreshToken 解密问题
 */

const path = require('path');
const dotenv = require('dotenv');
const crypto = require('crypto');

// 加载环境变量
dotenv.config({ path: path.join(__dirname, '..', '.env') });

const redis = require('../src/models/redis');
const logger = require('../src/utils/logger');
const config = require('../config/config');

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;
const GEMINI_ACCOUNT_KEY_PREFIX = 'gemini_account:';
const ENCRYPTION_SALT = 'gemini-encryption-salt-2024';

// 生成加密密钥（使用与 geminiAccountService 相同的方法）
function generateEncryptionKey() {
  return crypto.scryptSync(config.security.encryptionKey, ENCRYPTION_SALT, 32);
}

// 旧版解密函数（使用冒号分隔）
function decryptOld(text) {
  if (!text) return '';
  try {
    const key = generateEncryptionKey();
    const textParts = text.split(':');
    const iv = Buffer.from(textParts.shift(), 'hex');
    const encryptedText = Buffer.from(textParts.join(':'), 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (error) {
    return { error: error.message };
  }
}

// 新版解密函数（固定长度）
function decryptNew(text) {
  if (!text) return '';
  try {
    const key = generateEncryptionKey();
    // IV 是固定长度的 32 个十六进制字符（16 字节）
    const ivHex = text.substring(0, 32);
    const encryptedHex = text.substring(33); // 跳过冒号
    
    const iv = Buffer.from(ivHex, 'hex');
    const encryptedText = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    let decrypted = decipher.update(encryptedText);
    decrypted = Buffer.concat([decrypted, decipher.final()]);
    return decrypted.toString();
  } catch (error) {
    return { error: error.message };
  }
}

async function debugGeminiDecrypt() {
  try {
    console.log('🚀 开始调试 Gemini refreshToken 解密...\n');
    
    // 显示加密配置
    console.log('📋 加密配置检查:');
    console.log(`   config.security.encryptionKey: ${config.security.encryptionKey}`);
    console.log(`   实际使用的加密密钥长度: ${config.security.encryptionKey.length}`);
    console.log(`   ENCRYPTION_SALT: ${ENCRYPTION_SALT}`);
    console.log();
    
    // 连接 Redis
    console.log('📡 连接 Redis...');
    await redis.connect();
    console.log('✅ Redis 连接成功\n');
    
    // 获取 Gemini 账户
    const client = redis.getClient();
    const keys = await client.keys(`${GEMINI_ACCOUNT_KEY_PREFIX}*`);
    
    if (keys.length === 0) {
      console.log('❌ 没有找到 Gemini 账户');
      process.exit(1);
    }
    
    console.log(`🔍 找到 ${keys.length} 个 Gemini 账户\n`);
    
    for (const key of keys) {
      const accountData = await client.hgetall(key);
      const accountId = key.replace(GEMINI_ACCOUNT_KEY_PREFIX, '');
      
      console.log(`\n📋 账户: ${accountData.name} (${accountId})`);
      console.log(`   平台: ${accountData.platform}`);
      
      if (accountData.refreshToken) {
        console.log(`\n   🔐 RefreshToken 分析:`);
        console.log(`   原始长度: ${accountData.refreshToken.length}`);
        console.log(`   包含冒号: ${accountData.refreshToken.includes(':') ? '是' : '否'}`);
        console.log(`   前50字符: ${accountData.refreshToken.substring(0, 50)}...`);
        
        // 尝试旧版解密
        console.log(`\n   📝 尝试旧版解密（冒号分隔）:`);
        const oldResult = decryptOld(accountData.refreshToken);
        if (oldResult.error) {
          console.log(`   ❌ 失败: ${oldResult.error}`);
        } else {
          console.log(`   ✅ 成功！Token前20字符: ${oldResult.substring(0, 20)}...`);
        }
        
        // 尝试新版解密
        console.log(`\n   📝 尝试新版解密（固定长度）:`);
        const newResult = decryptNew(accountData.refreshToken);
        if (newResult.error) {
          console.log(`   ❌ 失败: ${newResult.error}`);
        } else {
          console.log(`   ✅ 成功！Token前20字符: ${newResult.substring(0, 20)}...`);
        }
        
        // 分析加密格式
        if (accountData.refreshToken.includes(':')) {
          const parts = accountData.refreshToken.split(':');
          console.log(`\n   📊 加密格式分析（按冒号分隔）:`);
          console.log(`   部分数量: ${parts.length}`);
          console.log(`   第一部分长度: ${parts[0].length} (应为32，即16字节的hex)`);
        }
      } else {
        console.log(`   ⚠️  无 refreshToken`);
      }
      
      console.log('\n' + '='.repeat(60));
    }
    
  } catch (error) {
    console.error('❌ 调试失败:', error);
  } finally {
    await redis.disconnect();
    process.exit(0);
  }
}

// 运行调试
debugGeminiDecrypt();