#!/bin/sh
set -e

echo "🚀 Claude Relay Service 启动中..."

# 检查是否需要初始化
if [ ! -f "/app/data/init.json" ]; then
  echo "📋 首次启动，执行初始化设置..."
  
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