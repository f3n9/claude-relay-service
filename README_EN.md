# Claude Relay Service

<div align="center">

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Redis](https://img.shields.io/badge/Redis-6+-red.svg)](https://redis.io/)
[![Docker](https://img.shields.io/badge/Docker-Ready-blue.svg)](https://www.docker.com/)

**🔐 Self-hosted Claude API relay service with multi-account management**

[English](#english) • [中文文档](#中文文档)

</div>

---

## ⚠️ Important Notice

**Please read carefully before using this project:**

🚨 **Terms of Service Risk**: Using this project may violate Anthropic's terms of service. Please carefully read Anthropic's user agreement before use. All risks from using this project are borne by the user.

📖 **Disclaimer**: This project is for technical learning and research purposes only. The author is not responsible for any account bans, service interruptions, or other losses caused by using this project.

---

## 🤔 Is This Project Right for You?

- 🌍 **Regional Restrictions**: Can't directly access Claude Code service in your region?
- 🔒 **Privacy Concerns**: Worried about third-party mirror services logging or leaking your conversation content?
- 👥 **Cost Sharing**: Want to share Claude Code Max subscription costs with friends?
- ⚡ **Stability**: Third-party mirror sites often have outages and instability, affecting efficiency?

If you nodded yes, this project might be for you.

### Suitable Scenarios

✅ **Cost Sharing with Friends**: 3-5 friends sharing Claude Code Max subscription, enjoying Opus freely  
✅ **Privacy Sensitive**: Don't want third parties to see your conversation content  
✅ **Technical Tinkering**: Have basic technical skills, willing to build and maintain yourself  
✅ **Stability Needs**: Need long-term stable Claude access, don't want to be restricted by mirror sites  
✅ **Regional Restrictions**: Cannot directly access Claude official service  

### Unsuitable Scenarios

❌ **Complete Beginner**: Don't understand technology at all, don't even know how to buy a server  
❌ **Occasional Use**: Use it only a few times a month, not worth the hassle  
❌ **Registration Issues**: Cannot register Claude account yourself  
❌ **Payment Issues**: No payment method to subscribe to Claude Code  

---

## 💭 Why Build Your Own?

Honestly, there are quite a few Claude proxy services online now, but there are also many issues:

### Problems with Existing Proxies

- 🕵️ **Privacy Risk**: Your conversation content is seen clearly by others, forget about business secrets
- 🐌 **Performance Instability**: Slow when many people use it, often crashes during peak hours
- 💰 **Price Opacity**: Don't know the actual costs

### Benefits of Self-hosting

- 🔐 **Data Security**: All API requests only go through your own server, direct connection to Anthropic API
- ⚡ **Controllable Performance**: Only a few of you using it, as fast as you want
- 💰 **Cost Transparency**: Clear view of how many tokens used, specific costs calculated at official prices
- 📊 **Complete Monitoring**: Usage statistics, cost analysis, performance monitoring all available

---

## 🚀 Core Features

### Basic Features
- ✅ **Multi-account Management**: Add multiple Claude accounts for automatic rotation
- ✅ **Custom API Keys**: Assign independent keys to each person
- ✅ **Usage Statistics**: Detailed records of how many tokens each person used

### Advanced Features
- 🔄 **Smart Switching**: Automatically switch to next account when one has issues
- 🚀 **Performance Optimization**: Connection pooling, caching to reduce latency
- 📊 **Monitoring Dashboard**: Web interface to view all data
- 🛡️ **Security Control**: Access restrictions, rate limiting
- 🌐 **Proxy Support**: Support for HTTP/SOCKS5 proxies

---

## 📋 Deployment Requirements

### Hardware Requirements (Minimum Configuration)
- **CPU**: 1 core is enough
- **Memory**: 512MB (1GB recommended)
- **Storage**: 30GB available space
- **Network**: Access to Anthropic API (recommend US region servers)
- **Suggestion**: 2 cores 4GB is basically enough, choose network with good return routes to your country (to improve speed, recommend not using proxy or setting server IP for direct connection)

### Software Requirements
- **Node.js** 18 or higher
- **Redis** 6 or higher
- **Operating System**: Linux recommended

### Cost Estimation
- **Server**: Light cloud server, 10-30 RMB per month
- **Claude Subscription**: Depends on how you share costs
- **Others**: Basically none

---

## 🐳 Simplest Deployment Method (Docker)

If you're too lazy to set up the environment, use Docker directly:

```bash
# 1. Download project
git clone https://github.com/yourusername/claude-relay-service.git
cd claude-relay-service

# 2. One-click start
docker-compose up -d

# 3. Check if started successfully
docker-compose ps
```

That simple, the service is running.

---

## 📦 Manual Deployment (For Tinkerers)

### Step 1: Environment Setup

**Ubuntu/Debian users:**
```bash
# Install Node.js
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install Redis
sudo apt update
sudo apt install redis-server
sudo systemctl start redis-server
```

**CentOS/RHEL users:**
```bash
# Install Node.js
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Install Redis
sudo yum install redis
sudo systemctl start redis
```

### Step 2: Download and Configure

```bash
# Download project
git clone https://github.com/yourusername/claude-relay-service.git
cd claude-relay-service

# Install dependencies
npm install

# Copy configuration files (Important!)
cp config/config.example.js config/config.js
cp .env.example .env
```

### Step 3: Configuration File Setup

**Edit `.env` file:**
```bash
# Generate these two keys randomly, but remember them
JWT_SECRET=your-super-secret-key
ENCRYPTION_KEY=32-character-encryption-key-write-randomly

# Redis configuration
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=
```

**Edit `config/config.js` file:**
```javascript
module.exports = {
  server: {
    port: 3000,          // Service port, can be changed
    host: '0.0.0.0'     // Don't change
  },
  redis: {
    host: '127.0.0.1',  // Redis address
    port: 6379          // Redis port
  },
  // Keep other configurations as default
}
```

### Step 4: Start Service

```bash
# Initialize
npm run setup

# Start service
npm run service:start:daemon   # Run in background (recommended)

# Check status
npm run service:status
```

---

## 🎮 Getting Started

### 1. Open Management Interface

Browser visit: `http://your-server-IP:3000/web`

Default admin account: admin / admin123

### 2. Add Claude Account

This step is quite important, requires OAuth authorization:

1. Click "Claude Accounts" tab
2. If you're in China, configure proxy first (Important!)
3. Click "Add Account"
4. Click "Generate Authorization Link", will open a new page
5. Complete Claude login and authorization in the new page
6. Copy the returned Authorization Code
7. Paste to page to complete addition

**Note**: If you're in China, this step may require VPN.

### 3. Create API Key

Assign a key to each user:

1. Click "API Keys" tab
2. Click "Create New Key"
3. Give the key a name, like "Zhang San's Key"
4. Set usage limits (optional)
5. Save, note down the generated key

### 4. Start Using API

Now you can replace the official API with your own service:

**Original request:**
```bash
curl https://api.anthropic.com/v1/messages \
  -H "x-api-key: official-key" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-sonnet-20240229","messages":[{"role":"user","content":"Hello"}]}'
```

**Current request:**
```bash
curl http://your-domain:3000/api/v1/messages \
  -H "x-api-key: cr_your-created-key" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-sonnet-20240229","messages":[{"role":"user","content":"Hello"}]}'
```

Just change the domain and API Key to your own generated one, everything else is the same.

---

## 🔧 Daily Maintenance

### Service Management

```bash
# Check service status
npm run service:status

# View logs
npm run service:logs

# Restart service
npm run service:restart:daemon

# Stop service
npm run service:stop
```

### Monitor Usage

- **Web Interface**: `http://your-domain:3000/web` - View usage statistics
- **Health Check**: `http://your-domain:3000/health` - Confirm service is normal
- **Log Files**: Various log files in `logs/` directory

### Common Issue Resolution

**Can't connect to Redis?**
```bash
# Check if Redis is running
redis-cli ping

# Should return PONG
```

**OAuth authorization failed?**
- Check if proxy settings are correct
- Ensure normal access to claude.ai
- Clear browser cache and retry

**API request failed?**
- Check if API Key is correct
- View log files for error information
- Confirm Claude account status is normal

---

## 🛠️ Advanced Usage

### Setting Up Proxy (Must-read for Chinese Users)

If you're in China, you need to configure proxy to use normally:

```javascript
// Add in account configuration
{
  "proxy": {
    "type": "socks5",           // or "http"
    "host": "127.0.0.1",
    "port": 1080,
    "username": "username",      // if proxy requires authentication
    "password": "password"       // if proxy requires authentication
  }
}
```

### Command Line Management Tool

Too lazy to open webpage? Use command line:

```bash
# View all API Keys
npm run cli keys list

# Create new Key
npm run cli keys create --name "Test Key" --limit 1000

# View account status
npm run cli accounts list

# Test account connection
npm run cli accounts test --id account-ID
```

### Production Deployment Recommendations (Important!)

**Strongly recommend using nginx reverse proxy + SSL certificate**

Directly exposing service ports poses security risks. It's recommended to use nginx reverse proxy with SSL certificate:

**1. Install nginx and obtain SSL certificate**
```bash
# Ubuntu/Debian
sudo apt install nginx certbot python3-certbot-nginx

# Get free SSL certificate (using Let's Encrypt as example)
sudo certbot --nginx -d your-domain.com
```

**2. nginx configuration example**

Create `/etc/nginx/sites-available/claude-relay` configuration file:
```nginx
server {
    listen 80;
    server_name your-domain.com;
    return 301 https://$server_name$request_uri;
}

server {
    listen 443 ssl http2;
    server_name your-domain.com;
    
    # SSL configuration
    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_ciphers HIGH:!aNULL:!MD5;
    
    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options DENY;
    add_header X-Content-Type-Options nosniff;
    
    # Reverse proxy configuration
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        
        # Timeout settings
        proxy_connect_timeout 60s;
        proxy_send_timeout 60s;
        proxy_read_timeout 60s;
    }
}
```

**3. Enable configuration**
```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/claude-relay /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# Restart nginx
sudo systemctl restart nginx
```

**4. Update service configuration**

Modify your service configuration to listen only locally:
```javascript
// config/config.js
module.exports = {
  server: {
    port: 3000,
    host: '127.0.0.1'  // Listen only locally, proxy through nginx
  }
  // ... other configurations
}
```

**5. Use HTTPS API**

After configuration, your API address becomes:
```bash
curl https://your-domain.com/api/v1/messages \
  -H "x-api-key: cr_your-key" \
  -H "content-type: application/json" \
  -d '{"model":"claude-3-sonnet-20240229","messages":[{"role":"user","content":"Hello"}]}'
```

**Security advantages:**
- 🔒 **Data Encryption**: All API requests transmitted through HTTPS encryption
- 🛡️ **Hide Ports**: Don't directly expose service ports, reduce attack surface
- 🚀 **Better Performance**: nginx's static file serving and caching capabilities
- 📊 **Access Logs**: nginx provides detailed access logs and monitoring

### Monitoring Integration

If you want more professional monitoring, you can integrate Prometheus:

Visit `https://your-domain/metrics` to get metrics data.

---

## 💡 Usage Recommendations

### Account Management
- **Multiple Accounts**: Recommend adding 2-3 Claude accounts to prevent single point of failure
- **Regular Checks**: Check account status weekly, handle exceptions promptly
- **Backup Plan**: Prepare several backup accounts that can step in during critical moments

### Cost Control
- **Set Limits**: Set reasonable usage limits for each API Key
- **Monitor Spending**: Regularly check cost statistics, control budget
- **Reasonable Allocation**: Allocate quotas based on usage frequency

### Security Recommendations
- **Use HTTPS**: Strongly recommend configuring nginx reverse proxy and SSL certificate to ensure secure data transmission
- **Regular Backups**: Back up important configurations and data
- **Monitor Logs**: Regularly check exception logs
- **Update Keys**: Regularly change JWT and encryption keys
- **Firewall Settings**: Only open necessary ports (80, 443), hide direct service ports

---

## 🆘 What to Do When You Encounter Problems?

### Self-troubleshooting
1. **Check Logs**: Log files in `logs/` directory
2. **Check Configuration**: Confirm configuration files are set correctly
3. **Test Connectivity**: Use curl to test if API is normal
4. **Restart Service**: Sometimes restarting fixes it

### Seeking Help
- **GitHub Issues**: Submit detailed error information
- **Read Documentation**: Carefully read error messages and documentation
- **Community Discussion**: See if others have encountered similar problems

---

## 📄 License
This project uses the [MIT License](LICENSE).

---

<div align="center">

**⭐ If you find it useful, please give it a Star, this is the greatest encouragement to the author!**

**🤝 Feel free to submit Issues for problems, welcome PRs for improvement suggestions**

</div>