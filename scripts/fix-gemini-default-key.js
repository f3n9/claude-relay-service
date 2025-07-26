#!/usr/bin/env node

/**
 * 修复使用默认密钥加密的 Gemini 账户数据
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

// 默认密钥（可能在创建时使用）
const DEFAULT_KEY = 'default-encryption-key-change-in-production';

// 生成加密密钥（使用默认密钥）
function generateDefaultKey() {
  return crypto.scryptSync(DEFAULT_KEY, ENCRYPTION_SALT, 32);
}

// 生成加密密钥（使用当前配置）
function generateCurrentKey() {
  return crypto.scryptSync(config.security.encryptionKey, ENCRYPTION_SALT, 32);
}

// 尝试使用指定密钥解密
function decryptWithKey(text, key) {
  if (!text) return '';
  try {
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
    return null;
  }
}

// 使用当前密钥加密
function encryptWithCurrentKey(text) {
  if (!text) return '';
  const key = generateCurrentKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

async function fixGeminiDefaultKey() {
  try {
    console.log('🚀 开始修复使用默认密钥加密的 Gemini 账户...\n');
    
    // 显示密钥信息
    console.log('📋 密钥信息:');
    console.log(`   默认密钥: ${DEFAULT_KEY}`);
    console.log(`   当前密钥: ${config.security.encryptionKey}`);
    console.log(`   密钥相同: ${DEFAULT_KEY === config.security.encryptionKey ? '是' : '否'}`);
    console.log();
    
    // 连接 Redis
    console.log('📡 连接 Redis...');
    await redis.connect();
    console.log('✅ Redis 连接成功\n');
    
    const client = redis.getClient();
    const keys = await client.keys(`${GEMINI_ACCOUNT_KEY_PREFIX}*`);
    
    if (keys.length === 0) {
      console.log('❌ 没有找到 Gemini 账户');
      process.exit(1);
    }
    
    console.log(`🔍 找到 ${keys.length} 个 Gemini 账户\n`);
    
    let fixedCount = 0;
    
    for (const key of keys) {
      const accountData = await client.hgetall(key);
      const accountId = key.replace(GEMINI_ACCOUNT_KEY_PREFIX, '');
      
      console.log(`\n📋 处理账户: ${accountData.name} (${accountId})`);
      
      if (!accountData.refreshToken) {
        console.log('   ⚠️  无 refreshToken，跳过');
        continue;
      }
      
      // 生成两种密钥
      const defaultKey = generateDefaultKey();
      const currentKey = generateCurrentKey();
      
      // 先尝试用当前密钥解密
      console.log('   🔐 尝试使用当前密钥解密...');
      let decryptedToken = decryptWithKey(accountData.refreshToken, currentKey);
      
      if (decryptedToken && decryptedToken.startsWith('1//')) {
        console.log('   ✅ 当前密钥解密成功，无需修复');
        continue;
      }
      
      // 尝试用默认密钥解密
      console.log('   🔐 尝试使用默认密钥解密...');
      decryptedToken = decryptWithKey(accountData.refreshToken, defaultKey);
      
      if (!decryptedToken || !decryptedToken.startsWith('1//')) {
        console.log('   ❌ 两种密钥都无法解密！');
        console.log('   💡 可能需要手动更新 refresh token');
        continue;
      }
      
      console.log('   ✅ 默认密钥解密成功！');
      console.log(`   📝 Token 前缀: ${decryptedToken.substring(0, 10)}...`);
      
      if (process.argv.includes('--fix')) {
        // 使用当前密钥重新加密
        console.log('   🔄 使用当前密钥重新加密...');
        
        const updates = {};
        
        // 重新加密 refreshToken
        updates.refreshToken = encryptWithCurrentKey(decryptedToken);
        
        // 同样处理 accessToken 和 geminiOauth
        if (accountData.accessToken) {
          const decryptedAccess = decryptWithKey(accountData.accessToken, defaultKey);
          if (decryptedAccess) {
            updates.accessToken = encryptWithCurrentKey(decryptedAccess);
          }
        }
        
        if (accountData.geminiOauth) {
          const decryptedOauth = decryptWithKey(accountData.geminiOauth, defaultKey);
          if (decryptedOauth) {
            updates.geminiOauth = encryptWithCurrentKey(decryptedOauth);
          }
        }
        
        // 更新 Redis
        await client.hmset(key, updates);
        console.log('   ✅ 已重新加密并保存');
        fixedCount++;
      } else {
        console.log('   ⚠️  使用 --fix 参数来修复此账户');
      }
    }
    
    console.log('\n' + '='.repeat(60));
    
    if (process.argv.includes('--fix')) {
      console.log(`\n✅ 修复完成！共修复 ${fixedCount} 个账户`);
    } else {
      console.log('\n💡 提示：使用 --fix 参数运行脚本以修复问题');
      console.log('   node scripts/fix-gemini-default-key.js --fix');
    }
    
  } catch (error) {
    console.error('❌ 修复失败:', error);
  } finally {
    await redis.disconnect();
    process.exit(0);
  }
}

// 运行修复
fixGeminiDefaultKey();