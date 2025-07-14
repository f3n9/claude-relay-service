# Claude Relay Service

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Redis](https://img.shields.io/badge/Redis-6+-red.svg)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)

**🔐 自己搭建的Claude API中转服务，支持多账户管理**

[English](#english) • [中文文档](#中文文档)

</div>

---

## ⚠️ 重要提醒

**使用本项目前请仔细阅读：**

🚨 **服务条款风险**: 使用本项目可能违反Anthropic的服务条款。请在使用前仔细阅读Anthropic的用户协议，使用本项目的一切风险由用户自行承担。

📖 **免责声明**: 本项目仅供技术学习和研究使用，作者不对因使用本项目导致的账户封禁、服务中断或其他损失承担任何责任。

---

## 🤔 这个项目适合你吗？

- 🌍 **地区限制**: 所在地区无法直接访问Claude Code服务？
- 🔒 **隐私担忧**: 担心第三方镜像服务会记录或泄露你的对话内容？
- 👥 **成本分摊**: 想和朋友一起分摊Claude Code Max订阅费用？
- ⚡ **稳定性**: 第三方镜像站经常故障不稳定，影响效率 ？

如果有以上困惑，那这个项目可能适合你。

### 适合的场景

✅ **找朋友拼车**: 三五好友一起分摊Claude Code Max订阅，Opus爽用  
✅ **隐私敏感**: 不想让第三方镜像看到你的对话内容  
✅ **技术折腾**: 有基本的技术基础，愿意自己搭建和维护 
✅ **稳定需求**: 需要长期稳定的Claude访问，不想受制于镜像站  
✅ **地区受限**: 无法直接访问Claude官方服务  

### 不适合的场景

❌ **纯小白**: 完全不懂技术，连服务器都不会买  
❌ **偶尔使用**: 一个月用不了几次，没必要折腾
❌ **注册问题**: 无法自行注册Claude账号
❌ **支付问题**: 没有支付渠道订阅Claude Code

---

## 💭 为什么要自己搭？


### 现有镜像站可能的问题

- 🕵️ **隐私风险**: 你的对话内容都被人家看得一清二楚，商业机密什么的就别想了
- 🐌 **性能不稳**: 用的人多了就慢，高峰期经常卡死
- 💰 **价格不透明**: 不知道实际成本

### 自建的好处

- 🔐 **数据安全**: 所有接口请求都只经过你自己的服务器，直连Anthropic API
- ⚡ **性能可控**: 就你们几个人用，Max 200刀套餐基本上可以爽用Opus
- 💰 **成本透明**: 用了多少token一目了然，按官方价格换算了具体费用
- 📊 **监控完整**: 使用情况、成本分析、性能监控全都有

---

## 🚀 核心功能

### 基础功能
- ✅ **多账户管理**: 可以添加多个Claude账户自动轮换
- ✅ **自定义API Key**: 给每个人分配独立的Key
- ✅ **使用统计**: 详细记录每个人用了多少token

### 高级功能
- 🔄 **智能切换**: 账户出问题自动换下一个
- 🚀 **性能优化**: 连接池、缓存，减少延迟
- 📊 **监控面板**: Web界面查看所有数据
- 🛡️ **安全控制**: 访问限制、速率控制
- 🌐 **代理支持**: 支持HTTP/SOCKS5代理

---

## 📋 部署要求

### 硬件要求（最低配置）
- **CPU**: 1核心就够了
- **内存**: 512MB（建议1GB）
- **硬盘**: 30GB可用空间
- **网络**: 能访问到Anthropic API（建议使用US地区的机器）
- **建议**: 2核4G的基本够了，网络尽量选回国线路快一点的（为了提高速度，建议不要开代理或者设置服务器的IP直连）

### 软件要求
- **Node.js** 18或更高版本
- **Redis** 6或更高版本
- **操作系统**: 建议Linux

### 费用估算
- **服务器**: 轻量云服务器，一个月10-30块
- **Claude订阅**: 看你怎么分摊了
- **其他**: 基本没有了

---

## 🐳 最简单的部署方式（Docker）

如果你懒得折腾环境，直接用Docker：

```bash
# 1. 下载项目
git clone https://github.com/yourusername/claude-relay-service.git
cd claude-relay-service

# 2. 一键启动
docker-compose up -d

# 3. 查看是否启动成功
docker-compose ps
```

就这么简单，服务就跑起来了。

---

## 📦 手动部署（适合折腾党）

### 第一步：环境准备

**Ubuntu/Debian用户：**
```bash
# 安装Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# 安装Redis
sudo apt update
sudo apt install redis-server
sudo systemctl start redis-server
```

**CentOS/RHEL用户：**
```bash
# 安装Node.js
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# 安装Redis
sudo yum install redis
sudo systemctl start redis
```

### 第二步：下载和配置

```bash
# 下载项目
git clone https://github.com/yourusername/claude-relay-service.git
cd claude-relay-service

# 安装依赖
npm install

# 复制配置文件（重要！）
cp config/config.example.js config/config.js
cp .env.example .env
```

### 第三步：配置文件设置

**编辑 `.env` 文件：**
```bash
# 这两个密钥随便生成，但要记住
JWT_SECRET=你的超级秘密密钥
ENCRYPTION_KEY=32位的加密密钥随便写

# Redis配置
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

**编辑 `config/config.js` 文件：**
```javascript
module.exports = {
  server: {
    port: 3000,          // 服务端口，可以改
    host: '0.0.0.0'     // 不用改
  },
  redis: {
    host: '127.0.0.1',  // Redis地址
    port: 6379          // Redis端口
  },
  // 其他配置保持默认就行
}
```

### 第四步：启动服务

```bash
# 初始化
npm run setup

# 启动服务
npm run service:start:daemon   # 后台运行（推荐）

# 查看状态
npm run service:status
```

---

## 🎮 开始使用

### 1. 打开管理界面

浏览器访问：`http://你的服务器IP:3000/web`

默认管理员账号：admin / admin123

### 2. 添加Claude账户

这一步比较关键，需要OAuth授权：

1. 点击「Claude账户」标签
2. 如果你在国内，先配置代理（重要！）
3. 点击「添加账户」
4. 点击「生成授权链接」，会打开一个新页面
5. 在新页面完成Claude登录和授权
6. 复制返回的Authorization Code
7. 粘贴到页面完成添加

**注意**: 如果你在国内，这一步可能需要科学上网。

### 3. 创建API Key

给每个使用者分配一个Key：

1. 点击「API Keys」标签
2. 点击「创建新Key」
3. 给Key起个名字，比如「张三的Key」
4. 设置使用限制（可选）
5. 保存，记下生成的Key

### 4. 开始使用API

现在你可以用自己的服务替换官方API了：

**原来的请求：**
```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: 官方的key" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-sonnet-20240229","messages":[{"role":"user","content":"你好"}]}'
```

**现在的请求：**
```bash
curl http://你的域名:3000/api/v1/messages \
  -H "x-api-key: cr_你创建的key" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-sonnet-20240229","messages":[{"role":"user","content":"你好"}]}'
```

就是把域名换一下，API Key换成你自己生成的，其他都一样。

---

## 🔧 日常维护

### 服务管理

```bash
# 查看服务状态
npm run service:status

# 查看日志
npm run service:logs

# 重启服务
npm run service:restart:daemon

# 停止服务
npm run service:stop
```

### 监控使用情况

- **Web界面**: `http://你的域名:3000/web` - 查看使用统计
- **健康检查**: `http://你的域名:3000/health` - 确认服务正常
- **日志文件**: `logs/` 目录下的各种日志文件

### 常见问题处理

**Redis连不上？**
```bash
# 检查Redis是否启动
redis-cli ping

# 应该返回 PONG
```

**OAuth授权失败？**
- 检查代理设置是否正确
- 确保能正常访问 claude.ai
- 清除浏览器缓存重试

**API请求失败？**
- 检查API Key是否正确
- 查看日志文件找错误信息
- 确认Claude账户状态正常

---

## 🛠️ 高级玩法

### 设置代理（国内用户必看）

如果你在国内，需要配置代理才能正常使用：

```javascript
// 在账户配置中添加
{
  "proxy": {
    "type": "socks5",           // 或者 "http"
    "host": "127.0.0.1",
    "port": 1080,
    "username": "用户名",        // 如果代理需要认证
    "password": "密码"          // 如果代理需要认证
  }
}
```

### 命令行管理工具

懒得打开网页？用命令行：

```bash
# 查看所有API Key
npm run cli keys list

# 创建新Key
npm run cli keys create --name "测试Key" --limit 1000

# 查看账户状态
npm run cli accounts list

# 测试账户连接
npm run cli accounts test --id 账户ID
```

### 监控集成

如果你想要更专业的监控，可以接入Prometheus：

访问 `http://你的域名(或IP):3000/metrics` 获取指标数据。

---

## 💡 使用建议

### 账户管理
- **多账户**: 建议添加2-3个Claude账户，防止单点故障
- **定期检查**: 每周看看账户状态，及时处理异常
- **备用方案**: 准备几个备用账户，关键时刻能顶上

### 成本控制
- **设置限额**: 给每个API Key设置合理的使用限制
- **监控支出**: 定期查看成本统计，控制预算
- **合理分配**: 根据使用频率分配配额

### 安全建议
- **定期备份**: 重要配置和数据要备份
- **监控日志**: 定期查看异常日志
- **更新密钥**: 定期更换JWT和加密密钥

---

## 🆘 遇到问题怎么办？

### 自助排查
1. **查看日志**: `logs/` 目录下的日志文件
2. **检查配置**: 确认配置文件设置正确
3. **测试连通性**: 用 curl 测试API是否正常
4. **重启服务**: 有时候重启一下就好了

### 寻求帮助
- **GitHub Issues**: 提交详细的错误信息
- **查看文档**: 仔细阅读错误信息和文档
- **社区讨论**: 看看其他人是否遇到类似问题

---

## 📄 许可证
本项目采用 [MIT许可证](LICENSE)。

---

<div align="center">

**⭐ 觉得有用的话给个Star呗，这是对作者最大的鼓励！**

**🤝 有问题欢迎提Issue，有改进建议欢迎PR**

</div>