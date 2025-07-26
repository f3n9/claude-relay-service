#!/usr/bin/env node

/**
 * 修复 Gemini 账户的加密数据
 * 
 * 问题：线上数据可能是用旧版本的加密方式存储的，需要重新加密
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

// 新的加密函数
function encrypt(text) {
  if (!text) return '';
  const key = generateEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

// 新的解密函数
function decrypt(text) {
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
    console.error('Decryption error:', error);
    return null;
  }
}

// 尝试多种解密方法
function tryDecrypt(encryptedText) {
  // 1. 尝试直接返回（可能未加密）
  if (encryptedText && encryptedText.startsWith('1//')) {
    console.log('   📝 数据看起来未加密（Google refresh token 格式）');
    return encryptedText;
  }
  
  // 2. 尝试标准解密
  const result = decrypt(encryptedText);
  if (result && result.startsWith('1//')) {
    console.log('   ✅ 使用标准解密成功');
    return result;
  }
  
  // 3. 可能是用不同的密钥加密的
  console.log('   ❌ 无法解密，可能需要原始 refresh token');
  return null;
}

async function fixGeminiEncryption() {
  try {
    console.log('🚀 开始修复 Gemini 账户加密...\n');
    
    // 显示加密配置
    console.log('📋 当前加密配置:');
    console.log(`   config.security.encryptionKey: ${config.security.encryptionKey}`);
    console.log(`   密钥长度: ${config.security.encryptionKey.length}`);
    console.log(`   ENCRYPTION_SALT: ${ENCRYPTION_SALT}`);
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
    
    for (const key of keys) {
      const accountData = await client.hgetall(key);
      const accountId = key.replace(GEMINI_ACCOUNT_KEY_PREFIX, '');
      
      console.log(`\n📋 处理账户: ${accountData.name} (${accountId})`);
      
      if (!accountData.refreshToken) {
        console.log('   ⚠️  无 refreshToken，跳过');
        continue;
      }
      
      // 尝试解密
      console.log('   🔐 尝试解密 refreshToken...');
      const decryptedToken = tryDecrypt(accountData.refreshToken);
      
      if (!decryptedToken) {
        console.log('   ❌ 解密失败！');
        console.log('   💡 建议：请提供原始的 refresh token 以修复此账户');
        console.log(`   📝 使用命令: npm run cli gemini-accounts update ${accountId} --refresh-token "YOUR_REFRESH_TOKEN"`);
        continue;
      }
      
      // 检查是否需要重新加密
      const testEncrypted = encrypt(decryptedToken);
      if (testEncrypted === accountData.refreshToken) {
        console.log('   ✅ 加密正常，无需修复');
        continue;
      }
      
      console.log('   🔄 需要重新加密...');
      console.log(`   解密后的 token 前缀: ${decryptedToken.substring(0, 10)}...`);
      
      // 询问是否要修复
      console.log('\n   ⚠️  警告：这将重新加密 refreshToken');
      console.log('   建议先备份当前数据！');
      console.log('   如果要继续修复，请使用 --fix 参数运行脚本');
      
      if (process.argv.includes('--fix')) {
        // 重新加密并更新
        const newEncrypted = encrypt(decryptedToken);
        await client.hset(key, 'refreshToken', newEncrypted);
        console.log('   ✅ 已重新加密并保存');
      }
    }
    
    console.log('\n✅ 检查完成！');
    
    if (!process.argv.includes('--fix')) {
      console.log('\n💡 提示：使用 --fix 参数运行脚本以修复加密问题');
      console.log('   node scripts/fix-gemini-encryption.js --fix');
    }
    
  } catch (error) {
    console.error('❌ 修复失败:', error);
  } finally {
    await redis.disconnect();
    process.exit(0);
  }
}

// 运行修复
fixGeminiEncryption();