#!/usr/bin/env node

// 并发控制功能测试脚本
// 用法: node test-concurrency.js <API_KEY> <并发数>

const https = require('https');
const http = require('http');

const API_KEY = process.argv[2];
const CONCURRENCY = parseInt(process.argv[3]) || 10;
const SERVER_URL = process.env.SERVER_URL || 'http://localhost:3000';

if (!API_KEY) {
  console.error('请提供API Key: node test-concurrency.js <API_KEY> <并发数>');
  process.exit(1);
}

// 解析URL
const url = new URL(SERVER_URL);
const protocol = url.protocol === 'https:' ? https : http;

// 发送单个请求
function sendRequest(index) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: '/api/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': API_KEY
      }
    };

    const req = protocol.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        const duration = Date.now() - startTime;
        
        if (res.statusCode === 429) {
          try {
            const response = JSON.parse(data);
            resolve({
              index,
              status: res.statusCode,
              error: response.error,
              message: response.message,
              concurrencyLimit: response.concurrencyLimit,
              currentConcurrency: response.currentConcurrency,
              duration
            });
          } catch (e) {
            resolve({
              index,
              status: res.statusCode,
              error: 'Rate limit exceeded',
              message: data,
              duration
            });
          }
        } else if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve({
            index,
            status: res.statusCode,
            success: true,
            duration
          });
        } else {
          resolve({
            index,
            status: res.statusCode,
            error: 'Request failed',
            message: data,
            duration
          });
        }
      });
    });

    req.on('error', (error) => {
      reject({
        index,
        error: error.message,
        duration: Date.now() - startTime
      });
    });

    // 发送测试请求
    const testData = JSON.stringify({
      model: 'claude-3-haiku-20240307',
      messages: [
        {
          role: 'user',
          content: `测试并发请求 #${index}`
        }
      ],
      max_tokens: 10,
      stream: false
    });

    req.write(testData);
    req.end();
  });
}

// 运行并发测试
async function runConcurrencyTest() {
  console.log(`\n🧪 开始并发控制测试`);
  console.log(`�� 服务器: ${SERVER_URL}`);
  console.log(`🔑 API Key: ${API_KEY.substring(0, 10)}...`);
  console.log(`🔄 并发请求数: ${CONCURRENCY}`);
  console.log(`⏰ 开始时间: ${new Date().toISOString()}\n`);

  // 创建并发请求
  const promises = [];
  for (let i = 1; i <= CONCURRENCY; i++) {
    promises.push(sendRequest(i));
  }

  // 等待所有请求完成
  try {
    const results = await Promise.all(promises);
    
    // 统计结果
    let successCount = 0;
    let rateLimitCount = 0;
    let errorCount = 0;
    let concurrencyLimit = null;
    let maxConcurrency = 0;

    console.log('📊 请求结果:\n');
    
    results.forEach(result => {
      if (result.success) {
        successCount++;
        console.log(`✅ 请求 #${result.index}: 成功 (${result.duration}ms)`);
      } else if (result.status === 429) {
        rateLimitCount++;
        if (result.concurrencyLimit) {
          concurrencyLimit = result.concurrencyLimit;
          if (result.currentConcurrency > maxConcurrency) {
            maxConcurrency = result.currentConcurrency;
          }
        }
        console.log(`🚫 请求 #${result.index}: ${result.message} (${result.duration}ms)`);
      } else {
        errorCount++;
        console.log(`❌ 请求 #${result.index}: ${result.error} - ${result.message} (${result.duration}ms)`);
      }
    });

    // 打印统计信息
    console.log('\n📈 测试统计:');
    console.log(`✅ 成功请求: ${successCount}`);
    console.log(`🚫 被限流请求: ${rateLimitCount}`);
    console.log(`❌ 错误请求: ${errorCount}`);
    
    if (concurrencyLimit !== null) {
      console.log(`\n🔐 并发限制信息:`);
      console.log(`📏 配置的并发限制: ${concurrencyLimit}`);
      console.log(`📊 检测到的最大并发数: ${maxConcurrency}`);
      
      if (successCount === concurrencyLimit && rateLimitCount === CONCURRENCY - concurrencyLimit) {
        console.log(`\n✅ 并发控制工作正常！成功限制了并发数为 ${concurrencyLimit}`);
      }
    } else if (successCount === CONCURRENCY) {
      console.log(`\n✅ 所有请求都成功了，该 API Key 没有并发限制或限制大于 ${CONCURRENCY}`);
    }
    
  } catch (error) {
    console.error('\n❌ 测试失败:', error);
  }
}

// 运行测试
runConcurrencyTest().catch(console.error);