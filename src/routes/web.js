const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const redis = require('../models/redis');
const logger = require('../utils/logger');
const config = require('../../config/config');

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
    const adminData = await redis.getSession('admin_credentials');
    
    if (!adminData || Object.keys(adminData).length === 0) {
      return res.status(401).json({
        error: 'Invalid credentials',
        message: 'Invalid username or password'
      });
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

// 🔑 Gemini OAuth 回调页面
router.get('/auth_gemini', (req, res) => {
  try {
    const code = req.query.code || '';
    const state = req.query.state || '';
    const error = req.query.error || '';
    const errorDescription = req.query.error_description || '';
    
    // 简单的 HTML 页面，用于显示授权码
    const html = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Gemini 授权回调</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background-color: #f5f5f5;
            margin: 0;
            padding: 0;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
        }
        .container {
            background: white;
            border-radius: 8px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
            padding: 40px;
            max-width: 600px;
            width: 90%;
        }
        h1 {
            color: #333;
            margin-bottom: 20px;
            font-size: 24px;
        }
        .success {
            color: #22c55e;
        }
        .error {
            color: #ef4444;
        }
        .code-box {
            background: #f3f4f6;
            border: 1px solid #e5e7eb;
            border-radius: 6px;
            padding: 15px;
            margin: 20px 0;
            word-break: break-all;
            font-family: 'Courier New', monospace;
            font-size: 14px;
            position: relative;
        }
        .copy-button {
            background: #3b82f6;
            color: white;
            border: none;
            border-radius: 6px;
            padding: 10px 20px;
            font-size: 16px;
            cursor: pointer;
            transition: background 0.2s;
        }
        .copy-button:hover {
            background: #2563eb;
        }
        .copy-button:active {
            background: #1d4ed8;
        }
        .instructions {
            color: #6b7280;
            margin-top: 20px;
            line-height: 1.5;
        }
        .step {
            margin: 10px 0;
            padding-left: 20px;
        }
    </style>
</head>
<body>
    <div class="container">
        ${error ? `
            <h1 class="error">授权失败</h1>
            <div class="error">
                <p><strong>错误：</strong> ${error}</p>
                ${errorDescription ? `<p><strong>描述：</strong> ${errorDescription}</p>` : ''}
            </div>
            <div class="instructions">
                <p>请关闭此页面并返回管理界面重试。</p>
            </div>
        ` : `
            <h1 class="success">授权成功</h1>
            <p>请复制下面的授权码：</p>
            <div class="code-box" id="codeBox">
                ${code}
            </div>
            <button class="copy-button" onclick="copyCode()">复制授权码</button>
            
            <div class="instructions">
                <p><strong>接下来的步骤：</strong></p>
                <div class="step">1. 点击上方按钮复制授权码</div>
                <div class="step">2. 返回到管理界面的创建账户页面</div>
                <div class="step">3. 将授权码粘贴到"授权码"输入框中</div>
                <div class="step">4. 点击"使用授权码创建账户"按钮完成创建</div>
            </div>
        `}
    </div>
    
    <script>
        function copyCode() {
            const code = document.getElementById('codeBox').innerText;
            navigator.clipboard.writeText(code).then(() => {
                const button = document.querySelector('.copy-button');
                const originalText = button.innerText;
                button.innerText = '已复制！';
                button.style.background = '#22c55e';
                
                setTimeout(() => {
                    button.innerText = originalText;
                    button.style.background = '#3b82f6';
                }, 2000);
            }).catch(err => {
                // 降级方案
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(document.getElementById('codeBox'));
                selection.removeAllRanges();
                selection.addRange(range);
                
                try {
                    document.execCommand('copy');
                    const button = document.querySelector('.copy-button');
                    button.innerText = '已复制！';
                    button.style.background = '#22c55e';
                } catch (e) {
                    alert('复制失败，请手动选择并复制授权码');
                }
            });
        }
        
        // 自动选中授权码文本
        window.onload = function() {
            const codeBox = document.getElementById('codeBox');
            if (codeBox && !${!!error}) {
                const selection = window.getSelection();
                const range = document.createRange();
                range.selectNodeContents(codeBox);
                selection.removeAllRanges();
                selection.addRange(range);
            }
        };
    </script>
</body>
</html>
    `;
    
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
    
    logger.info(`📄 Served Gemini OAuth callback page: ${error ? 'error' : 'success'}`);
  } catch (error) {
    logger.error('❌ Error serving Gemini OAuth callback:', error);
    res.status(500).send('Internal server error');
  }
});

module.exports = router;