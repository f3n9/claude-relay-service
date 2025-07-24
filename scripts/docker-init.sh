#!/bin/bash
# Docker 初始化脚本 - 在宿主机上运行

echo "🚀 Claude Relay Service Docker 初始化"

# 检查 .env 文件
if [ ! -f ".env" ]; then
    echo "📋 检测到 .env 文件不存在，从模板创建..."
    
    if [ -f ".env.example" ]; then
        cp .env.example .env
        echo "✅ .env 文件已创建"
        
        # 生成随机密钥
        echo "🔑 生成安全密钥..."
        
        # 生成64字符的JWT_SECRET
        JWT_SECRET=$(openssl rand -base64 48 | tr -d "=+/" | cut -c1-64)
        # 生成32字符的ENCRYPTION_KEY
        ENCRYPTION_KEY=$(openssl rand -base64 24 | tr -d "=+/" | cut -c1-32)
        
        # 替换默认值
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            sed -i '' "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
            sed -i '' "s/ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$ENCRYPTION_KEY/" .env
        else
            # Linux
            sed -i "s/JWT_SECRET=.*/JWT_SECRET=$JWT_SECRET/" .env
            sed -i "s/ENCRYPTION_KEY=.*/ENCRYPTION_KEY=$ENCRYPTION_KEY/" .env
        fi
        
        echo "✅ 密钥已生成并保存到 .env 文件"
        echo ""
        echo "📌 请妥善保管 .env 文件，它包含重要的加密密钥！"
    else
        echo "❌ 错误：.env.example 文件不存在"
        echo "请确保在项目根目录下运行此脚本"
        exit 1
    fi
else
    echo "✅ .env 文件已存在，跳过创建"
fi

# 创建必要的目录
echo "📁 创建必要的目录..."
mkdir -p data logs redis_data
echo "✅ 目录创建完成"

echo ""
echo "🎉 初始化完成！现在可以运行："
echo "   docker-compose up -d"