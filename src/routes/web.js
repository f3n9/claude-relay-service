const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const redis = require('../models/redis');
const logger = require('../utils/logger');
const config = require('../../config/config');
const apiKeyService = require('../services/apiKeyService');
const CostCalculator = require('../utils/costCalculator');

const router = express.Router();

// 🏠 服务静态文件
router.use('/assets', express.static(path.join(__dirname, '../../web/assets')));

// 🔒 Web管理界面文件白名单 - 仅允许这些特定文件
const ALLOWED_FILES = {
  'index.html': {
    path: path.join(__dirname, '../../web/admin/index.html'),
    contentType: 'text/html; charset=utf-8'
  },
  'app.js': {
    path: path.join(__dirname, '../../web/admin/app.js'),
    contentType: 'application/javascript; charset=utf-8'
  },
  'style.css': {
    path: path.join(__dirname, '../../web/admin/style.css'),
    contentType: 'text/css; charset=utf-8'
  },
  'userStats.html': {
    path: path.join(__dirname, '../../web/userStats/index.html'),
    contentType: 'text/html; charset=utf-8'
  },
  'userStats.js': {
    path: path.join(__dirname, '../../web/userStats/app.js'),
    contentType: 'application/javascript; charset=utf-8'
  },
  'userStats.css': {
    path: path.join(__dirname, '../../web/userStats/style.css'),
    contentType: 'text/css; charset=utf-8'
  }
};

// 🛡️ 安全文件服务函数
function serveWhitelistedFile(req, res, filename) {
  const fileConfig = ALLOWED_FILES[filename];
  
  if (!fileConfig) {
    logger.security(`🚨 Attempted access to non-whitelisted file: ${filename}`);
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    // 检查文件是否存在
    if (!fs.existsSync(fileConfig.path)) {
      logger.error(`❌ Whitelisted file not found: ${fileConfig.path}`);
      return res.status(404).json({ error: 'File not found' });
    }

    // 读取并返回文件内容
    const content = fs.readFileSync(fileConfig.path, 'utf8');
    res.setHeader('Content-Type', fileConfig.contentType);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.send(content);
    
    logger.info(`📄 Served whitelisted file: ${filename}`);
  } catch (error) {
    logger.error(`❌ Error serving file ${filename}:`, error);
    res.status(500).json({ error: 'Internal server error' });
  }
}

// 🔐 管理员登录
router.post('/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({
        error: 'Missing credentials',
        message: 'Username and password are required'
      });
    }

    // 从Redis获取管理员信息
    let adminData = await redis.getSession('admin_credentials');
    
    // 如果Redis中没有管理员凭据，尝试从init.json重新加载
    if (!adminData || Object.keys(adminData).length === 0) {
      const initFilePath = path.join(__dirname, '../../data/init.json');
      
      if (fs.existsSync(initFilePath)) {
        try {
          const initData = JSON.parse(fs.readFileSync(initFilePath, 'utf8'));
          const saltRounds = 10;
          const passwordHash = await bcrypt.hash(initData.adminPassword, saltRounds);
          
          adminData = {
            username: initData.adminUsername,
            passwordHash: passwordHash,
            createdAt: initData.initializedAt || new Date().toISOString(),
            lastLogin: null,
            updatedAt: initData.updatedAt || null
          };
          
          // 重新存储到Redis，不设置过期时间
          await redis.getClient().hset('session:admin_credentials', adminData);
          
          logger.info('✅ Admin credentials reloaded from init.json');
        } catch (error) {
          logger.error('❌ Failed to reload admin credentials:', error);
          return res.status(401).json({
            error: 'Invalid credentials',
            message: 'Invalid username or password'
          });
        }
      } else {
        return res.status(401).json({
          error: 'Invalid credentials',
          message: 'Invalid username or password'
        });
      }
    }

    // 验证用户名和密码
    const isValidUsername = adminData.username === username;
    const isValidPassword = await bcrypt.compare(password, adminData.passwordHash);

    if (!isValidUsername || !isValidPassword) {
      logger.security(`🔒 Failed login attempt for username: ${username}`);
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Invalid username or password'
      });
    }

    // 生成会话token
    const sessionId = crypto.randomBytes(32).toString('hex');
    
    // 存储会话
    const sessionData = {
      username: adminData.username,
      loginTime: new Date().toISOString(),
      lastActivity: new Date().toISOString()
    };
    
    await redis.setSession(sessionId, sessionData, config.security.adminSessionTimeout);
    
    // 不再更新 Redis 中的最后登录时间，因为 Redis 只是缓存
    // init.json 是唯一真实数据源

    logger.success(`🔐 Admin login successful: ${username}`);

    res.json({
      success: true,
      token: sessionId,
      expiresIn: config.security.adminSessionTimeout,
      username: adminData.username // 返回真实用户名
    });

  } catch (error) {
    logger.error('❌ Login error:', error);
    res.status(500).json({
      error: 'Login failed',
      message: 'Internal server error'
    });
  }
});

// 🚪 管理员登出
router.post('/auth/logout', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken;
    
    if (token) {
      await redis.deleteSession(token);
      logger.success('🚪 Admin logout successful');
    }

    res.json({ success: true, message: 'Logout successful' });
  } catch (error) {
    logger.error('❌ Logout error:', error);
    res.status(500).json({
      error: 'Logout failed',
      message: 'Internal server error'
    });
  }
});

// 🔑 修改账户信息
router.post('/auth/change-password', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken;
    
    if (!token) {
      return res.status(401).json({
        error: 'No token provided',
        message: 'Authentication required'
      });
    }

    const { newUsername, currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({
        error: 'Missing required fields',
        message: 'Current password and new password are required'
      });
    }

    // 验证新密码长度
    if (newPassword.length < 8) {
      return res.status(400).json({
        error: 'Password too short',
        message: 'New password must be at least 8 characters long'
      });
    }

    // 获取当前会话
    const sessionData = await redis.getSession(token);
    if (!sessionData) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Session expired or invalid'
      });
    }

    // 获取当前管理员信息
    const adminData = await redis.getSession('admin_credentials');
    if (!adminData) {
      return res.status(500).json({
        error: 'Admin data not found',
        message: 'Administrator credentials not found'
      });
    }

    // 验证当前密码
    const isValidPassword = await bcrypt.compare(currentPassword, adminData.passwordHash);
    if (!isValidPassword) {
      logger.security(`🔒 Invalid current password attempt for user: ${sessionData.username}`);
      return res.status(401).json({
        error: 'Invalid current password',
        message: 'Current password is incorrect'
      });
    }

    // 准备更新的数据
    const updatedUsername = newUsername && newUsername.trim() ? newUsername.trim() : adminData.username;
    
    // 先更新 init.json（唯一真实数据源）
    const initFilePath = path.join(__dirname, '../../data/init.json');
    if (!fs.existsSync(initFilePath)) {
      return res.status(500).json({
        error: 'Configuration file not found',
        message: 'init.json file is missing'
      });
    }
    
    try {
      const initData = JSON.parse(fs.readFileSync(initFilePath, 'utf8'));
      // const oldData = { ...initData }; // 备份旧数据
      
      // 更新 init.json
      initData.adminUsername = updatedUsername;
      initData.adminPassword = newPassword; // 保存明文密码到init.json
      initData.updatedAt = new Date().toISOString();
      
      // 先写入文件（如果失败则不会影响 Redis）
      fs.writeFileSync(initFilePath, JSON.stringify(initData, null, 2));
      
      // 文件写入成功后，更新 Redis 缓存
      const saltRounds = 10;
      const newPasswordHash = await bcrypt.hash(newPassword, saltRounds);
      
      const updatedAdminData = {
        username: updatedUsername,
        passwordHash: newPasswordHash,
        createdAt: adminData.createdAt,
        lastLogin: adminData.lastLogin,
        updatedAt: new Date().toISOString()
      };
      
      await redis.setSession('admin_credentials', updatedAdminData);
      
    } catch (fileError) {
      logger.error('❌ Failed to update init.json:', fileError);
      return res.status(500).json({
        error: 'Update failed',
        message: 'Failed to update configuration file'
      });
    }

    // 清除当前会话（强制用户重新登录）
    await redis.deleteSession(token);

    logger.success(`🔐 Admin password changed successfully for user: ${updatedUsername}`);

    res.json({
      success: true,
      message: 'Password changed successfully. Please login again.',
      newUsername: updatedUsername
    });

  } catch (error) {
    logger.error('❌ Change password error:', error);
    res.status(500).json({
      error: 'Change password failed',
      message: 'Internal server error'
    });
  }
});

// 👤 获取当前用户信息
router.get('/auth/user', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken;
    
    if (!token) {
      return res.status(401).json({
        error: 'No token provided',
        message: 'Authentication required'
      });
    }

    // 获取当前会话
    const sessionData = await redis.getSession(token);
    if (!sessionData) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Session expired or invalid'
      });
    }

    // 获取管理员信息
    const adminData = await redis.getSession('admin_credentials');
    if (!adminData) {
      return res.status(500).json({
        error: 'Admin data not found',
        message: 'Administrator credentials not found'
      });
    }

    res.json({
      success: true,
      user: {
        username: adminData.username,
        loginTime: sessionData.loginTime,
        lastActivity: sessionData.lastActivity
      }
    });

  } catch (error) {
    logger.error('❌ Get user info error:', error);
    res.status(500).json({
      error: 'Get user info failed',
      message: 'Internal server error'
    });
  }
});

// 🔄 刷新token
router.post('/auth/refresh', async (req, res) => {
  try {
    const token = req.headers['authorization']?.replace('Bearer ', '') || req.cookies?.adminToken;
    
    if (!token) {
      return res.status(401).json({
        error: 'No token provided',
        message: 'Authentication required'
      });
    }

    const sessionData = await redis.getSession(token);
    
    if (!sessionData) {
      return res.status(401).json({
        error: 'Invalid token',
        message: 'Session expired or invalid'
      });
    }

    // 更新最后活动时间
    sessionData.lastActivity = new Date().toISOString();
    await redis.setSession(token, sessionData, config.security.adminSessionTimeout);

    res.json({
      success: true,
      token: token,
      expiresIn: config.security.adminSessionTimeout
    });

  } catch (error) {
    logger.error('❌ Token refresh error:', error);
    res.status(500).json({
      error: 'Token refresh failed',
      message: 'Internal server error'
    });
  }
});

// 🌐 Web管理界面路由 - 使用固定白名单
router.get('/', (req, res) => {
  serveWhitelistedFile(req, res, 'index.html');
});

router.get('/app.js', (req, res) => {
  serveWhitelistedFile(req, res, 'app.js');
});

router.get('/style.css', (req, res) => {
  serveWhitelistedFile(req, res, 'style.css');
});

// 📊 用户统计页面路由
router.get('/userStats', (req, res) => {
  serveWhitelistedFile(req, res, 'userStats.html');
});

router.get('/userStats.js', (req, res) => {
  serveWhitelistedFile(req, res, 'userStats.js');
});

router.get('/userStats.css', (req, res) => {
  serveWhitelistedFile(req, res, 'userStats.css');
});

// 📊 用户API Key统计查询接口 - 安全的自查询接口
router.post('/api/user-stats', async (req, res) => {
  try {
    const { apiKey } = req.body;
    
    if (!apiKey) {
      logger.security(`🔒 Missing API key in user stats query from ${req.ip || 'unknown'}`);
      return res.status(400).json({
        error: 'API Key is required',
        message: 'Please provide your API Key'
      });
    }

    // 基本API Key格式验证
    if (typeof apiKey !== 'string' || apiKey.length < 10 || apiKey.length > 512) {
      logger.security(`🔒 Invalid API key format in user stats query from ${req.ip || 'unknown'}`);
      return res.status(400).json({
        error: 'Invalid API key format',
        message: 'API key format is invalid'
      });
    }

    // 验证API Key（重用现有的验证逻辑）
    const validation = await apiKeyService.validateApiKey(apiKey);
    
    if (!validation.valid) {
      const clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
      logger.security(`🔒 Invalid API key in user stats query: ${validation.error} from ${clientIP}`);
      return res.status(401).json({
        error: 'Invalid API key',
        message: validation.error
      });
    }

    const keyData = validation.keyData;

    // 记录合法查询
    logger.api(`📊 User stats query from key: ${keyData.name} (${keyData.id}) from ${req.ip || 'unknown'}`);

    // 获取验证结果中的完整keyData（包含isActive状态和cost信息）
    const fullKeyData = validation.keyData;
    
    // 计算总费用 - 使用与模型统计相同的逻辑（按模型分别计算）
    let totalCost = 0;
    let formattedCost = '$0.000000';
    
    try {
      const client = redis.getClientSafe();
      const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
      
      // 获取所有月度模型统计（与model-stats接口相同的逻辑）
      const allModelKeys = await client.keys(`usage:${fullKeyData.id}:model:monthly:*:*`);
      const modelUsageMap = new Map();
      
      for (const key of allModelKeys) {
        const modelMatch = key.match(/usage:.+:model:monthly:(.+):(\d{4}-\d{2})$/);
        if (!modelMatch) continue;
        
        const model = modelMatch[1];
        const data = await client.hgetall(key);
        
        if (data && Object.keys(data).length > 0) {
          if (!modelUsageMap.has(model)) {
            modelUsageMap.set(model, {
              inputTokens: 0,
              outputTokens: 0,
              cacheCreateTokens: 0,
              cacheReadTokens: 0
            });
          }
          
          const modelUsage = modelUsageMap.get(model);
          modelUsage.inputTokens += parseInt(data.inputTokens) || 0;
          modelUsage.outputTokens += parseInt(data.outputTokens) || 0;
          modelUsage.cacheCreateTokens += parseInt(data.cacheCreateTokens) || 0;
          modelUsage.cacheReadTokens += parseInt(data.cacheReadTokens) || 0;
        }
      }
      
      // 按模型计算费用并汇总
      for (const [model, usage] of modelUsageMap) {
        const usageData = {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          cache_creation_input_tokens: usage.cacheCreateTokens,
          cache_read_input_tokens: usage.cacheReadTokens
        };
        
        const costResult = CostCalculator.calculateCost(usageData, model);
        totalCost += costResult.costs.total;
      }
      
      // 如果没有模型级别的详细数据，回退到总体数据计算
      if (modelUsageMap.size === 0 && fullKeyData.usage?.total?.allTokens > 0) {
        const usage = fullKeyData.usage.total;
        const costUsage = {
          input_tokens: usage.inputTokens || 0,
          output_tokens: usage.outputTokens || 0,
          cache_creation_input_tokens: usage.cacheCreateTokens || 0,
          cache_read_input_tokens: usage.cacheReadTokens || 0
        };
        
        const costResult = CostCalculator.calculateCost(costUsage, 'claude-3-5-sonnet-20241022');
        totalCost = costResult.costs.total;
      }
      
      formattedCost = CostCalculator.formatCost(totalCost);
      
    } catch (error) {
      logger.warn(`Failed to calculate detailed cost for key ${fullKeyData.id}:`, error);
      // 回退到简单计算
      if (fullKeyData.usage?.total?.allTokens > 0) {
        const usage = fullKeyData.usage.total;
        const costUsage = {
          input_tokens: usage.inputTokens || 0,
          output_tokens: usage.outputTokens || 0,
          cache_creation_input_tokens: usage.cacheCreateTokens || 0,
          cache_read_input_tokens: usage.cacheReadTokens || 0
        };
        
        const costResult = CostCalculator.calculateCost(costUsage, 'claude-3-5-sonnet-20241022');
        totalCost = costResult.costs.total;
        formattedCost = costResult.formatted.total;
      }
    }

    // 构建响应数据（只返回该API Key自己的信息，确保不泄露其他信息）
    const responseData = {
      id: fullKeyData.id,
      name: fullKeyData.name,
      description: keyData.description || '',
      isActive: true, // 如果能通过validateApiKey验证，说明一定是激活的
      createdAt: keyData.createdAt,
      expiresAt: keyData.expiresAt,
      permissions: fullKeyData.permissions,
      
      // 使用统计（使用验证结果中的完整数据）
      usage: {
        total: {
          ...(fullKeyData.usage?.total || {
            requests: 0,
            tokens: 0,
            allTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreateTokens: 0,
            cacheReadTokens: 0
          }),
          cost: totalCost,
          formattedCost: formattedCost
        }
      },
      
      // 限制信息（只显示配置，不显示当前使用量）
      limits: {
        tokenLimit: fullKeyData.tokenLimit || 0,
        concurrencyLimit: fullKeyData.concurrencyLimit || 0,
        rateLimitWindow: fullKeyData.rateLimitWindow || 0,
        rateLimitRequests: fullKeyData.rateLimitRequests || 0,
        dailyCostLimit: fullKeyData.dailyCostLimit || 0
      },
      
      // 绑定的账户信息（只显示ID，不显示敏感信息）
      accounts: {
        claudeAccountId: fullKeyData.claudeAccountId && fullKeyData.claudeAccountId !== '' ? fullKeyData.claudeAccountId : null,
        geminiAccountId: fullKeyData.geminiAccountId && fullKeyData.geminiAccountId !== '' ? fullKeyData.geminiAccountId : null
      },
      
      // 模型和客户端限制信息
      restrictions: {
        enableModelRestriction: fullKeyData.enableModelRestriction || false,
        restrictedModels: fullKeyData.restrictedModels || [],
        enableClientRestriction: fullKeyData.enableClientRestriction || false,
        allowedClients: fullKeyData.allowedClients || []
      }
    };

    res.json({
      success: true,
      data: responseData
    });

  } catch (error) {
    logger.error('❌ Failed to process user stats query:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve API key statistics'
    });
  }
});

// 📊 用户模型统计查询接口 - 安全的自查询接口
router.post('/api/user-model-stats', async (req, res) => {
  try {
    const { apiKey, period = 'monthly' } = req.body;
    
    if (!apiKey) {
      logger.security(`🔒 Missing API key in user model stats query from ${req.ip || 'unknown'}`);
      return res.status(400).json({
        error: 'API Key is required',
        message: 'Please provide your API Key'
      });
    }

    // 验证API Key
    const validation = await apiKeyService.validateApiKey(apiKey);
    
    if (!validation.valid) {
      const clientIP = req.ip || req.connection?.remoteAddress || 'unknown';
      logger.security(`🔒 Invalid API key in user model stats query: ${validation.error} from ${clientIP}`);
      return res.status(401).json({
        error: 'Invalid API key',
        message: validation.error
      });
    }

    const keyData = validation.keyData;
    logger.api(`📊 User model stats query from key: ${keyData.name} (${keyData.id}) for period: ${period}`);

    // 重用管理后台的模型统计逻辑，但只返回该API Key的数据
    const client = redis.getClientSafe();
    const today = new Date().toISOString().split('T')[0];
    const currentMonth = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
    
    const pattern = period === 'daily' ? 
      `usage:${keyData.id}:model:daily:*:${today}` : 
      `usage:${keyData.id}:model:monthly:*:${currentMonth}`;
    
    const keys = await client.keys(pattern);
    const modelStats = [];
    
    for (const key of keys) {
      const match = key.match(period === 'daily' ? 
        /usage:.+:model:daily:(.+):\d{4}-\d{2}-\d{2}$/ : 
        /usage:.+:model:monthly:(.+):\d{4}-\d{2}$/
      );
      
      if (!match) continue;
      
      const model = match[1];
      const data = await client.hgetall(key);
      
      if (data && Object.keys(data).length > 0) {
        const usage = {
          input_tokens: parseInt(data.inputTokens) || 0,
          output_tokens: parseInt(data.outputTokens) || 0,
          cache_creation_input_tokens: parseInt(data.cacheCreateTokens) || 0,
          cache_read_input_tokens: parseInt(data.cacheReadTokens) || 0
        };
        
        const costData = CostCalculator.calculateCost(usage, model);
        
        modelStats.push({
          model,
          requests: parseInt(data.requests) || 0,
          inputTokens: usage.input_tokens,
          outputTokens: usage.output_tokens,
          cacheCreateTokens: usage.cache_creation_input_tokens,
          cacheReadTokens: usage.cache_read_input_tokens,
          allTokens: parseInt(data.allTokens) || 0,
          costs: costData.costs,
          formatted: costData.formatted,
          pricing: costData.pricing
        });
      }
    }

    // 如果没有详细的模型数据，尝试从总体usage中生成
    if (modelStats.length === 0 && keyData.usage?.total) {
      const usageData = keyData.usage.total;
      
      if (usageData.allTokens > 0) {
        const usage = {
          input_tokens: usageData.inputTokens || 0,
          output_tokens: usageData.outputTokens || 0,
          cache_creation_input_tokens: usageData.cacheCreateTokens || 0,
          cache_read_input_tokens: usageData.cacheReadTokens || 0
        };
        
        const costData = CostCalculator.calculateCost(usage, 'claude-3-5-sonnet-20241022');
        
        modelStats.push({
          model: '总体使用 (历史数据)',
          requests: usageData.requests || 0,
          inputTokens: usageData.inputTokens || 0,
          outputTokens: usageData.outputTokens || 0,
          cacheCreateTokens: usageData.cacheCreateTokens || 0,
          cacheReadTokens: usageData.cacheReadTokens || 0,
          allTokens: usageData.allTokens || 0,
          costs: costData.costs,
          formatted: costData.formatted,
          pricing: costData.pricing
        });
      }
    }

    // 按总token数降序排列
    modelStats.sort((a, b) => b.allTokens - a.allTokens);

    res.json({
      success: true,
      data: modelStats,
      period: period
    });

  } catch (error) {
    logger.error('❌ Failed to process user model stats query:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: 'Failed to retrieve model statistics'
    });
  }
});


// 🔑 Gemini OAuth 回调页面

module.exports = router;