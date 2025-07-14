#!/usr/bin/env node

const { Command } = require('commander');
const inquirer = require('inquirer');
const chalk = require('chalk');
const ora = require('ora');
const Table = require('table').table;
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

const config = require('../config/config');
const redis = require('../src/models/redis');
const apiKeyService = require('../src/services/apiKeyService');
const claudeAccountService = require('../src/services/claudeAccountService');

const program = new Command();

// 🎨 样式
const styles = {
  title: chalk.bold.blue,
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.cyan,
  dim: chalk.dim
};

// 🔧 初始化
async function initialize() {
  const spinner = ora('正在连接 Redis...').start();
  try {
    await redis.connect();
    spinner.succeed('Redis 连接成功');
  } catch (error) {
    spinner.fail('Redis 连接失败');
    console.error(styles.error(error.message));
    process.exit(1);
  }
}

// 🔐 管理员账户管理
program
  .command('admin')
  .description('管理员账户操作')
  .action(async () => {
    await initialize();
    
    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: '选择操作:',
      choices: [
        { name: '🔑 设置管理员密码', value: 'set-password' },
        { name: '👤 创建初始管理员', value: 'create-admin' },
        { name: '🔄 重置管理员密码', value: 'reset-password' },
        { name: '📊 查看管理员信息', value: 'view-admin' }
      ]
    });

    switch (action) {
      case 'set-password':
        await setAdminPassword();
        break;
      case 'create-admin':
        await createInitialAdmin();
        break;
      case 'reset-password':
        await resetAdminPassword();
        break;
      case 'view-admin':
        await viewAdminInfo();
        break;
    }
    
    await redis.disconnect();
  });

// 🔑 API Key 管理
program
  .command('keys')
  .description('API Key 管理')
  .action(async () => {
    await initialize();
    
    // 尝试兼容不同版本的inquirer
    let prompt = inquirer.prompt || inquirer.default?.prompt || inquirer;
    if (typeof prompt !== 'function') {
      prompt = (await import('inquirer')).default;
    }
    
    const { action } = await prompt({
      type: 'list',
      name: 'action',
      message: '选择操作:',
      choices: [
        { name: '📋 列出所有 API Keys', value: 'list' },
        { name: '🔑 创建新的 API Key', value: 'create' },
        { name: '📝 更新 API Key', value: 'update' },
        { name: '🗑️  删除 API Key', value: 'delete' },
        { name: '📊 查看使用统计', value: 'stats' },
        { name: '🧹 重置所有统计数据', value: 'reset-stats' }
      ]
    });

    switch (action) {
      case 'list':
        await listApiKeys();
        break;
      case 'create':
        await createApiKey();
        break;
      case 'update':
        await updateApiKey();
        break;
      case 'delete':
        await deleteApiKey();
        break;
      case 'stats':
        await viewApiKeyStats();
        break;
      case 'reset-stats':
        await resetAllApiKeyStats();
        break;
    }
    
    await redis.disconnect();
  });

// 🏢 Claude 账户管理
program
  .command('accounts')
  .description('Claude 账户管理')
  .action(async () => {
    await initialize();
    
    const { action } = await inquirer.prompt({
      type: 'list',
      name: 'action',
      message: '选择操作:',
      choices: [
        { name: '📋 列出所有账户', value: 'list' },
        { name: '🏢 创建新账户', value: 'create' },
        { name: '📝 更新账户', value: 'update' },
        { name: '🗑️  删除账户', value: 'delete' },
        { name: '🔄 刷新 Token', value: 'refresh' },
        { name: '🧪 测试账户', value: 'test' }
      ]
    });

    switch (action) {
      case 'list':
        await listClaudeAccounts();
        break;
      case 'create':
        await createClaudeAccount();
        break;
      case 'update':
        await updateClaudeAccount();
        break;
      case 'delete':
        await deleteClaudeAccount();
        break;
      case 'refresh':
        await refreshAccountToken();
        break;
      case 'test':
        await testClaudeAccount();
        break;
    }
    
    await redis.disconnect();
  });

// 🧹 重置统计数据命令
program
  .command('reset-stats')
  .description('重置所有API Key的统计数据')
  .option('--force', '跳过确认直接重置')
  .option('--debug', '显示详细的Redis键调试信息')
  .action(async (options) => {
    await initialize();
    
    console.log(styles.title('\n🧹 重置所有API Key统计数据\n'));
    
    // 如果启用调试，显示当前Redis键
    if (options.debug) {
      console.log(styles.info('🔍 调试模式: 检查Redis中的实际键...\n'));
      try {
        const usageKeys = await redis.getClient().keys('usage:*');
        const apiKeyKeys = await redis.getClient().keys('apikey:*');
        
        console.log(styles.dim('API Key 键:'));
        apiKeyKeys.forEach(key => console.log(`  ${key}`));
        
        console.log(styles.dim('\nUsage 键:'));
        usageKeys.forEach(key => console.log(`  ${key}`));
        
        // 检查今日统计键
        const today = new Date().toISOString().split('T')[0];
        const dailyKeys = await redis.getClient().keys(`usage:daily:*:${today}`);
        console.log(styles.dim(`\n今日统计键 (${today}):`));
        dailyKeys.forEach(key => console.log(`  ${key}`));
        
        console.log('');
      } catch (error) {
        console.error(styles.error('调试信息获取失败:', error.message));
      }
    }
    
    // 显示警告信息
    console.log(styles.warning('⚠️  警告: 此操作将删除所有API Key的使用统计数据!'));
    console.log(styles.dim('   包括: Token使用量、请求数量、每日/每月统计、最后使用时间等'));
    console.log(styles.dim('   此操作不可逆，请谨慎操作!\n'));

    if (!options.force) {
      console.log(styles.info('如需强制执行，请使用: npm run cli reset-stats -- --force\n'));
      console.log(styles.error('操作已取消 - 请添加 --force 参数确认重置'));
      await redis.disconnect();
      return;
    }

    // 获取当前统计概览
    const spinner = ora('正在获取当前统计数据...').start();
    try {
      const apiKeys = await apiKeyService.getAllApiKeys();
      const totalTokens = apiKeys.reduce((sum, key) => sum + (key.usage?.total?.tokens || 0), 0);
      const totalRequests = apiKeys.reduce((sum, key) => sum + (key.usage?.total?.requests || 0), 0);
      
      spinner.succeed('统计数据获取完成');
      
      console.log(styles.info('\n📊 当前统计概览:'));
      console.log(`   API Keys 数量: ${apiKeys.length}`);
      console.log(`   总 Token 使用量: ${totalTokens.toLocaleString()}`);
      console.log(`   总请求数量: ${totalRequests.toLocaleString()}\n`);

      // 执行重置操作
      const resetSpinner = ora('正在重置所有API Key统计数据...').start();
      
      const stats = await redis.resetAllUsageStats();
      
      resetSpinner.succeed('所有统计数据重置完成');
      
      // 显示重置结果
      console.log(styles.success('\n✅ 重置操作完成!\n'));
      console.log(styles.info('📊 重置详情:'));
      console.log(`   重置的API Key数量: ${stats.resetApiKeys}`);
      console.log(`   删除的总体统计: ${stats.deletedKeys} 个`);
      console.log(`   删除的每日统计: ${stats.deletedDailyKeys} 个`);
      console.log(`   删除的每月统计: ${stats.deletedMonthlyKeys} 个`);
      
      console.log(styles.warning('\n💡 提示: API Key本身未被删除，只是清空了使用统计数据'));

    } catch (error) {
      spinner.fail('重置操作失败');
      console.error(styles.error(error.message));
    }
    
    await redis.disconnect();
  });

// 📊 系统状态
program
  .command('status')
  .description('查看系统状态')
  .action(async () => {
    await initialize();
    
    const spinner = ora('正在获取系统状态...').start();
    
    try {
      const [systemStats, apiKeys, accounts] = await Promise.all([
        redis.getSystemStats(),
        apiKeyService.getAllApiKeys(),
        claudeAccountService.getAllAccounts()
      ]);

      spinner.succeed('系统状态获取成功');

      console.log(styles.title('\n📊 系统状态概览\n'));
      
      const statusData = [
        ['项目', '数量', '状态'],
        ['API Keys', apiKeys.length, `${apiKeys.filter(k => k.isActive).length} 活跃`],
        ['Claude 账户', accounts.length, `${accounts.filter(a => a.isActive).length} 活跃`],
        ['Redis 连接', redis.isConnected ? '已连接' : '未连接', redis.isConnected ? '🟢' : '🔴'],
        ['运行时间', `${Math.floor(process.uptime() / 60)} 分钟`, '🕐']
      ];

      console.log(table(statusData));

      // 使用统计
      const totalTokens = apiKeys.reduce((sum, key) => sum + (key.usage?.total?.tokens || 0), 0);
      const totalRequests = apiKeys.reduce((sum, key) => sum + (key.usage?.total?.requests || 0), 0);

      console.log(styles.title('\n📈 使用统计\n'));
      console.log(`总 Token 使用量: ${styles.success(totalTokens.toLocaleString())}`);
      console.log(`总请求数: ${styles.success(totalRequests.toLocaleString())}`);

    } catch (error) {
      spinner.fail('获取系统状态失败');
      console.error(styles.error(error.message));
    }
    
    await redis.disconnect();
  });

// 🧹 清理命令
program
  .command('cleanup')
  .description('清理过期数据')
  .action(async () => {
    await initialize();
    
    const { confirm } = await inquirer.prompt({
      type: 'confirm',
      name: 'confirm',
      message: '确定要清理过期数据吗？',
      default: false
    });

    if (!confirm) {
      console.log(styles.warning('操作已取消'));
      await redis.disconnect();
      return;
    }

    const spinner = ora('正在清理过期数据...').start();
    
    try {
      const [expiredKeys, errorAccounts] = await Promise.all([
        apiKeyService.cleanupExpiredKeys(),
        claudeAccountService.cleanupErrorAccounts()
      ]);
      
      await redis.cleanup();
      
      spinner.succeed('清理完成');
      console.log(`${styles.success('✅')} 清理了 ${expiredKeys} 个过期 API Key`);
      console.log(`${styles.success('✅')} 重置了 ${errorAccounts} 个错误账户`);

    } catch (error) {
      spinner.fail('清理失败');
      console.error(styles.error(error.message));
    }
    
    await redis.disconnect();
  });

// 实现具体功能函数

async function createInitialAdmin() {
  console.log(styles.title('\n🔐 创建初始管理员账户\n'));
  
  const adminData = await inquirer.prompt([
    {
      type: 'input',
      name: 'username',
      message: '用户名:',
      default: 'admin',
      validate: input => input.length >= 3 || '用户名至少3个字符'
    },
    {
      type: 'password',
      name: 'password',
      message: '密码:',
      validate: input => input.length >= 8 || '密码至少8个字符'
    },
    {
      type: 'password',
      name: 'confirmPassword',
      message: '确认密码:',
      validate: (input, answers) => input === answers.password || '密码不匹配'
    }
  ]);

  const spinner = ora('正在创建管理员账户...').start();
  
  try {
    const passwordHash = await bcrypt.hash(adminData.password, 12);
    
    const credentials = {
      username: adminData.username,
      passwordHash,
      createdAt: new Date().toISOString(),
      id: crypto.randomBytes(16).toString('hex')
    };

    await redis.setSession('admin_credentials', credentials, 0); // 永不过期
    
    spinner.succeed('管理员账户创建成功');
    console.log(`${styles.success('✅')} 用户名: ${adminData.username}`);
    console.log(`${styles.info('ℹ️')} 请妥善保管登录凭据`);

  } catch (error) {
    spinner.fail('创建管理员账户失败');
    console.error(styles.error(error.message));
  }
}

async function setAdminPassword() {
  console.log(styles.title('\n🔑 设置管理员密码\n'));
  
  const passwordData = await inquirer.prompt([
    {
      type: 'password',
      name: 'newPassword',
      message: '新密码:',
      validate: input => input.length >= 8 || '密码至少8个字符'
    },
    {
      type: 'password',
      name: 'confirmPassword',
      message: '确认密码:',
      validate: (input, answers) => input === answers.newPassword || '密码不匹配'
    }
  ]);

  const spinner = ora('正在更新密码...').start();
  
  try {
    const adminData = await redis.getSession('admin_credentials');
    
    if (!adminData || Object.keys(adminData).length === 0) {
      spinner.fail('未找到管理员账户');
      console.log(styles.warning('请先创建初始管理员账户'));
      return;
    }

    const passwordHash = await bcrypt.hash(passwordData.newPassword, 12);
    adminData.passwordHash = passwordHash;
    adminData.updatedAt = new Date().toISOString();

    await redis.setSession('admin_credentials', adminData, 0);
    
    spinner.succeed('密码更新成功');
    console.log(`${styles.success('✅')} 管理员密码已更新`);

  } catch (error) {
    spinner.fail('密码更新失败');
    console.error(styles.error(error.message));
  }
}

async function listApiKeys() {
  const spinner = ora('正在获取 API Keys...').start();
  
  try {
    const apiKeys = await apiKeyService.getAllApiKeys();
    spinner.succeed(`找到 ${apiKeys.length} 个 API Key`);

    if (apiKeys.length === 0) {
      console.log(styles.warning('没有找到任何 API Key'));
      return;
    }

    const tableData = [
      ['ID', '名称', '状态', 'Token使用', '请求数', '创建时间']
    ];

    apiKeys.forEach(key => {
      tableData.push([
        key.id.substring(0, 8) + '...',
        key.name,
        key.isActive ? '🟢 活跃' : '🔴 停用',
        key.usage?.total?.tokens?.toLocaleString() || '0',
        key.usage?.total?.requests?.toLocaleString() || '0',
        new Date(key.createdAt).toLocaleDateString()
      ]);
    });

    console.log('\n📋 API Keys 列表:\n');
    console.log(table(tableData));

  } catch (error) {
    spinner.fail('获取 API Keys 失败');
    console.error(styles.error(error.message));
  }
}

async function createApiKey() {
  console.log(styles.title('\n🔑 创建新的 API Key\n'));
  
  const keyData = await inquirer.prompt([
    {
      type: 'input',
      name: 'name',
      message: 'API Key 名称:',
      validate: input => input.length > 0 || '名称不能为空'
    },
    {
      type: 'input',
      name: 'description',
      message: '描述 (可选):'
    },
    {
      type: 'number',
      name: 'tokenLimit',
      message: 'Token 限制 (0=无限制):',
      default: 1000000
    },
    {
      type: 'number',
      name: 'requestLimit',
      message: '请求限制 (0=无限制):',
      default: 1000
    }
  ]);

  const spinner = ora('正在创建 API Key...').start();
  
  try {
    const newKey = await apiKeyService.generateApiKey(keyData);
    
    spinner.succeed('API Key 创建成功');
    console.log(`${styles.success('✅')} API Key: ${styles.warning(newKey.apiKey)}`);
    console.log(`${styles.info('ℹ️')} 请妥善保管此 API Key，它只会显示一次`);

  } catch (error) {
    spinner.fail('创建 API Key 失败');
    console.error(styles.error(error.message));
  }
}

async function resetAllApiKeyStats() {
  console.log(styles.title('\n🧹 重置所有API Key统计数据\n'));
  
  // 显示警告信息
  console.log(styles.warning('⚠️  警告: 此操作将删除所有API Key的使用统计数据!'));
  console.log(styles.dim('   包括: Token使用量、请求数量、每日/每月统计、最后使用时间等'));
  console.log(styles.dim('   此操作不可逆，请谨慎操作!\n'));

  // 第一次确认
  const { firstConfirm } = await inquirer.prompt({
    type: 'confirm',
    name: 'firstConfirm',
    message: '您确定要重置所有API Key的统计数据吗？',
    default: false
  });

  if (!firstConfirm) {
    console.log(styles.info('操作已取消'));
    return;
  }

  // 获取当前统计概览
  const spinner = ora('正在获取当前统计数据...').start();
  try {
    const apiKeys = await apiKeyService.getAllApiKeys();
    const totalTokens = apiKeys.reduce((sum, key) => sum + (key.usage?.total?.tokens || 0), 0);
    const totalRequests = apiKeys.reduce((sum, key) => sum + (key.usage?.total?.requests || 0), 0);
    
    spinner.succeed('统计数据获取完成');
    
    console.log(styles.info('\n📊 当前统计概览:'));
    console.log(`   API Keys 数量: ${apiKeys.length}`);
    console.log(`   总 Token 使用量: ${totalTokens.toLocaleString()}`);
    console.log(`   总请求数量: ${totalRequests.toLocaleString()}\n`);

    // 第二次确认（需要输入"RESET"）
    const { confirmation } = await inquirer.prompt({
      type: 'input',
      name: 'confirmation',
      message: '请输入 "RESET" 来确认重置操作:',
      validate: input => input === 'RESET' || '请输入正确的确认文本 "RESET"'
    });

    if (confirmation !== 'RESET') {
      console.log(styles.info('操作已取消'));
      return;
    }

    // 执行重置操作
    const resetSpinner = ora('正在重置所有API Key统计数据...').start();
    
    const stats = await redis.resetAllUsageStats();
    
    resetSpinner.succeed('所有统计数据重置完成');
    
    // 显示重置结果
    console.log(styles.success('\n✅ 重置操作完成!\n'));
    console.log(styles.info('📊 重置详情:'));
    console.log(`   重置的API Key数量: ${stats.resetApiKeys}`);
    console.log(`   删除的总体统计: ${stats.deletedKeys} 个`);
    console.log(`   删除的每日统计: ${stats.deletedDailyKeys} 个`);
    console.log(`   删除的每月统计: ${stats.deletedMonthlyKeys} 个`);
    
    console.log(styles.warning('\n💡 提示: API Key本身未被删除，只是清空了使用统计数据'));

  } catch (error) {
    spinner.fail('重置操作失败');
    console.error(styles.error(error.message));
  }
}

async function viewApiKeyStats() {
  console.log(styles.title('\n📊 API Key 使用统计\n'));
  
  const spinner = ora('正在获取统计数据...').start();
  
  try {
    const apiKeys = await apiKeyService.getAllApiKeys();
    
    if (apiKeys.length === 0) {
      spinner.succeed('获取完成');
      console.log(styles.warning('没有找到任何 API Key'));
      return;
    }

    spinner.succeed(`找到 ${apiKeys.length} 个 API Key 的统计数据`);

    const tableData = [
      ['名称', 'Token总量', '输入Token', '输出Token', '请求数', '最后使用']
    ];

    let totalTokens = 0;
    let totalRequests = 0;

    apiKeys.forEach(key => {
      const usage = key.usage?.total || {};
      const tokens = usage.tokens || 0;
      const inputTokens = usage.inputTokens || 0;
      const outputTokens = usage.outputTokens || 0;
      const requests = usage.requests || 0;
      
      totalTokens += tokens;
      totalRequests += requests;

      tableData.push([
        key.name,
        tokens.toLocaleString(),
        inputTokens.toLocaleString(),
        outputTokens.toLocaleString(),
        requests.toLocaleString(),
        key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : '从未使用'
      ]);
    });

    console.log(table(tableData));
    
    console.log(styles.info('\n📈 总计统计:'));
    console.log(`总 Token 使用量: ${styles.success(totalTokens.toLocaleString())}`);
    console.log(`总请求数量: ${styles.success(totalRequests.toLocaleString())}`);

  } catch (error) {
    spinner.fail('获取统计数据失败');
    console.error(styles.error(error.message));
  }
}

async function updateApiKey() {
  console.log(styles.title('\n📝 更新 API Key\n'));
  console.log(styles.warning('功能开发中...'));
}

async function deleteApiKey() {
  console.log(styles.title('\n🗑️ 删除 API Key\n'));
  console.log(styles.warning('功能开发中...'));
}

async function resetAdminPassword() {
  console.log(styles.title('\n🔄 重置管理员密码\n'));
  console.log(styles.warning('功能开发中...'));
}

async function viewAdminInfo() {
  console.log(styles.title('\n👤 管理员信息\n'));
  
  const spinner = ora('正在获取管理员信息...').start();
  
  try {
    const adminData = await redis.getSession('admin_credentials');
    
    if (!adminData || Object.keys(adminData).length === 0) {
      spinner.fail('未找到管理员账户');
      console.log(styles.warning('请先创建初始管理员账户'));
      return;
    }

    spinner.succeed('管理员信息获取成功');
    
    console.log(`用户名: ${styles.info(adminData.username)}`);
    console.log(`创建时间: ${styles.dim(new Date(adminData.createdAt).toLocaleString())}`);
    console.log(`最后登录: ${adminData.lastLogin ? styles.dim(new Date(adminData.lastLogin).toLocaleString()) : '从未登录'}`);

  } catch (error) {
    spinner.fail('获取管理员信息失败');
    console.error(styles.error(error.message));
  }
}

async function createClaudeAccount() {
  console.log(styles.title('\n🏢 创建 Claude 账户\n'));
  console.log(styles.warning('功能开发中... 请使用Web界面创建OAuth账户'));
}

async function updateClaudeAccount() {
  console.log(styles.title('\n📝 更新 Claude 账户\n'));
  console.log(styles.warning('功能开发中...'));
}

async function deleteClaudeAccount() {
  console.log(styles.title('\n🗑️ 删除 Claude 账户\n'));
  console.log(styles.warning('功能开发中...'));
}

async function refreshAccountToken() {
  console.log(styles.title('\n🔄 刷新账户 Token\n'));
  console.log(styles.warning('功能开发中...'));
}

async function testClaudeAccount() {
  console.log(styles.title('\n🧪 测试 Claude 账户\n'));
  console.log(styles.warning('功能开发中...'));
}

async function listClaudeAccounts() {
  const spinner = ora('正在获取 Claude 账户...').start();
  
  try {
    const accounts = await claudeAccountService.getAllAccounts();
    spinner.succeed(`找到 ${accounts.length} 个 Claude 账户`);

    if (accounts.length === 0) {
      console.log(styles.warning('没有找到任何 Claude 账户'));
      return;
    }

    const tableData = [
      ['ID', '名称', '邮箱', '状态', '代理', '最后使用']
    ];

    accounts.forEach(account => {
      tableData.push([
        account.id.substring(0, 8) + '...',
        account.name,
        account.email || '-',
        account.isActive ? (account.status === 'active' ? '🟢 活跃' : '🟡 待激活') : '🔴 停用',
        account.proxy ? '🌐 是' : '-',
        account.lastUsedAt ? new Date(account.lastUsedAt).toLocaleDateString() : '-'
      ]);
    });

    console.log('\n🏢 Claude 账户列表:\n');
    console.log(table(tableData));

  } catch (error) {
    spinner.fail('获取 Claude 账户失败');
    console.error(styles.error(error.message));
  }
}

// 程序信息
program
  .name('claude-relay-cli')
  .description('Claude Relay Service 命令行管理工具')
  .version('1.0.0');

// 解析命令行参数
program.parse();

// 如果没有提供命令，显示帮助
if (!process.argv.slice(2).length) {
  console.log(styles.title('🚀 Claude Relay Service CLI\n'));
  console.log('使用以下命令管理服务:\n');
  console.log('  claude-relay-cli admin         - 管理员账户操作');
  console.log('  claude-relay-cli keys          - API Key 管理 (包含重置统计数据)');
  console.log('  claude-relay-cli accounts      - Claude 账户管理');
  console.log('  claude-relay-cli status        - 查看系统状态');
  console.log('  claude-relay-cli cleanup       - 清理过期数据');
  console.log('  claude-relay-cli reset-stats   - 重置所有API Key统计数据');
  console.log('\n使用 --help 查看详细帮助信息');
}