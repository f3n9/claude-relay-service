#!/bin/sh
set -e

echo "🚀 Claude Relay Service 启动中..."

# 生成随机字符串的函数
generate_random_string() {
  length=$1
  # 使用 /dev/urandom 生成随机字符串
  tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c $length
}

# 检查并复制配置文件
if [ ! -f "/app/config/config.js" ]; then
  echo "📋 检测到 config.js 不存在，从模板创建..."
  if [ -f "/app/config/config.example.js" ]; then
    cp /app/config/config.example.js /app/config/config.js
    echo "✅ config.js 已创建"
  else
    echo "❌ 错误: config.example.js 不存在"
    exit 1
  fi
fi

# 检查并配置 .env 文件（文件已在构建时创建）
if [ -f "/app/.env" ]; then
  echo "📋 配置 .env 文件..."
  
  # 生成随机的 JWT_SECRET (64字符)
  if [ -z "$JWT_SECRET" ]; then
    JWT_SECRET=$(grep "^JWT_SECRET=" /app/.env | cut -d'=' -f2)
    if [ -z "$JWT_SECRET" ] || [ "$JWT_SECRET" = "your-jwt-secret-here" ]; then
      JWT_SECRET=$(generate_random_string 64)
      echo "🔑 生成 JWT_SECRET"
    fi
  fi
  
  # 生成随机的 ENCRYPTION_KEY (32字符)
  if [ -z "$ENCRYPTION_KEY" ]; then
    ENCRYPTION_KEY=$(grep "^ENCRYPTION_KEY=" /app/.env | cut -d'=' -f2)
    if [ -z "$ENCRYPTION_KEY" ] || [ "$ENCRYPTION_KEY" = "your-encryption-key-here" ]; then
      ENCRYPTION_KEY=$(generate_random_string 32)
      echo "🔑 生成 ENCRYPTION_KEY"
    fi
  fi
  
  # 更新 .env 文件中的密钥
  sed -i "s/JWT_SECRET=.*/JWT_SECRET=${JWT_SECRET}/" /app/.env
  sed -i "s/ENCRYPTION_KEY=.*/ENCRYPTION_KEY=${ENCRYPTION_KEY}/" /app/.env
  
  # 设置 Redis 配置以连接到容器内的 Redis
  sed -i "s/REDIS_HOST=.*/REDIS_HOST=redis/" /app/.env
  
  echo "✅ .env 已配置"
else
  echo "❌ 错误: .env 文件不存在"
  exit 1
fi

# 导出环境变量
export JWT_SECRET
export ENCRYPTION_KEY

# 检查是否需要初始化
if [ ! -f "/app/data/init.json" ]; then
  echo "📋 首次启动，执行初始化设置..."
  
  # 调试权限信息
  echo "🔍 当前用户: $(whoami)"
  echo "🔍 data 目录权限: $(ls -ld /app/data 2>/dev/null || echo 'directory not found')"
  echo "🔍 data 目录内容: $(ls -la /app/data 2>/dev/null || echo 'directory empty or not accessible')"
  
  # 如果设置了环境变量，显示提示
  if [ -n "$ADMIN_USERNAME" ] || [ -n "$ADMIN_PASSWORD" ]; then
    echo "📌 检测到预设的管理员凭据"
  fi
  
  # 执行初始化脚本
  node /app/scripts/setup.js
  
  echo "✅ 初始化完成"
else
  echo "✅ 检测到已有配置，跳过初始化"
  
  # 如果 init.json 存在但环境变量也设置了，显示警告
  if [ -n "$ADMIN_USERNAME" ] || [ -n "$ADMIN_PASSWORD" ]; then
    echo "⚠️  警告: 检测到环境变量 ADMIN_USERNAME/ADMIN_PASSWORD，但系统已初始化"
    echo "   如需使用新凭据，请删除 data/init.json 文件后重启容器"
  fi
fi

# 启动应用
echo "🌐 启动 Claude Relay Service..."
exec "$@"