#!/bin/bash
# Docker Compose 初始化脚本 - 用于 Docker Hub 镜像部署

echo "🚀 Claude Relay Service Docker 初始化脚本"
echo "============================================"

# 检查是否在正确的目录
if [ -f "docker-compose.yml" ]; then
    echo "✅ 检测到 docker-compose.yml，继续初始化..."
else
    echo "⚠️  未检测到 docker-compose.yml 文件"
    echo "   请确保在包含 docker-compose.yml 的目录下运行此脚本"
    echo ""
    echo "如果您是从 Docker Hub 部署，请先创建 docker-compose.yml："
    echo "  参考文档：https://github.com/Wei-Shaw/claude-relay-service#docker-部署推荐"
    exit 1
fi

# 确保 .env 文件正确创建
echo ""
echo "📋 检查 .env 文件..."

if [ -d ".env" ]; then
    echo "❌ 检测到 .env 是目录（Docker 创建错误）"
    echo "   正在修复..."
    rm -rf .env
    touch .env
    echo "✅ 已删除目录并创建正确的 .env 文件"
elif [ ! -f ".env" ]; then
    echo "📝 创建 .env 文件..."
    touch .env
    echo "✅ .env 文件已创建"
else
    echo "✅ .env 文件已存在"
fi

# 创建必要的目录
echo ""
echo "📁 创建必要的目录..."
mkdir -p data logs redis_data
echo "✅ 目录创建完成"

# 显示文件状态
echo ""
echo "📊 当前文件状态："
echo "   .env: $([ -f .env ] && echo "✅ 文件" || echo "❌ 不存在")"
echo "   data/: $([ -d data ] && echo "✅ 目录" || echo "❌ 不存在")"
echo "   logs/: $([ -d logs ] && echo "✅ 目录" || echo "❌ 不存在")"
echo "   redis_data/: $([ -d redis_data ] && echo "✅ 目录" || echo "❌ 不存在")"

echo ""
echo "🎉 初始化完成！"
echo ""
echo "下一步操作："
echo "1. 启动服务："
echo "   docker-compose up -d"
echo ""
echo "2. 查看日志获取管理员密码："
echo "   docker-compose logs claude-relay | grep '管理员'"
echo ""
echo "3. 访问管理界面："
echo "   http://your-server:3000/web"