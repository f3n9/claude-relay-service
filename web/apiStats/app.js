// 初始化 dayjs 插件
dayjs.extend(dayjs_plugin_relativeTime);
dayjs.extend(dayjs_plugin_timezone);
dayjs.extend(dayjs_plugin_utc);

const { createApp } = Vue;

const app = createApp({
    data() {
        return {
            // 用户输入
            apiKey: '',
            
            // 状态控制
            loading: false,
            modelStatsLoading: false,
            error: '',
            
            // 时间范围控制
            statsPeriod: 'daily', // 默认今日
            
            // 数据
            statsData: null,
            modelStats: [],
            
            // 分时间段的统计数据
            dailyStats: null,
            monthlyStats: null
        };
    },
    
    methods: {
        // 🔍 查询统计数据
        async queryStats() {
            if (!this.apiKey.trim()) {
                this.error = '请输入 API Key';
                return;
            }
            
            this.loading = true;
            this.error = '';
            this.statsData = null;
            this.modelStats = [];
            
            try {
                const response = await fetch('/apiStats/api/user-stats', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        apiKey: this.apiKey
                    })
                });
                
                const result = await response.json();
                
                if (!response.ok) {
                    throw new Error(result.message || '查询失败');
                }
                
                if (result.success) {
                    this.statsData = result.data;
                    
                    // 同时加载今日和本月的统计数据
                    await this.loadAllPeriodStats();
                    
                    // 清除错误信息
                    this.error = '';
                } else {
                    throw new Error(result.message || '查询失败');
                }
                
            } catch (error) {
                console.error('Query stats error:', error);
                this.error = error.message || '查询统计数据失败，请检查您的 API Key 是否正确';
                this.statsData = null;
                this.modelStats = [];
            } finally {
                this.loading = false;
            }
        },
        
        // 📊 加载所有时间段的统计数据
        async loadAllPeriodStats() {
            if (!this.apiKey.trim()) {
                return;
            }
            
            // 并行加载今日和本月的数据
            await Promise.all([
                this.loadPeriodStats('daily'),
                this.loadPeriodStats('monthly')
            ]);
            
            // 加载当前选择时间段的模型统计
            await this.loadModelStats(this.statsPeriod);
        },
        
        // 📊 加载指定时间段的统计数据
        async loadPeriodStats(period) {
            try {
                const response = await fetch('/apiStats/api/user-model-stats', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        apiKey: this.apiKey,
                        period: period
                    })
                });
                
                const result = await response.json();
                
                if (response.ok && result.success) {
                    // 计算汇总数据
                    const modelData = result.data || [];
                    const summary = {
                        requests: 0,
                        inputTokens: 0,
                        outputTokens: 0,
                        cacheCreateTokens: 0,
                        cacheReadTokens: 0,
                        allTokens: 0,
                        cost: 0,
                        formattedCost: '$0.000000'
                    };
                    
                    modelData.forEach(model => {
                        summary.requests += model.requests || 0;
                        summary.inputTokens += model.inputTokens || 0;
                        summary.outputTokens += model.outputTokens || 0;
                        summary.cacheCreateTokens += model.cacheCreateTokens || 0;
                        summary.cacheReadTokens += model.cacheReadTokens || 0;
                        summary.allTokens += model.allTokens || 0;
                        summary.cost += model.costs?.total || 0;
                    });
                    
                    summary.formattedCost = this.formatCost(summary.cost);
                    
                    // 存储到对应的时间段数据
                    if (period === 'daily') {
                        this.dailyStats = summary;
                    } else {
                        this.monthlyStats = summary;
                    }
                } else {
                    console.warn(`Failed to load ${period} stats:`, result.message);
                }
                
            } catch (error) {
                console.error(`Load ${period} stats error:`, error);
            }
        },
        
        // 📊 加载模型统计数据
        async loadModelStats(period = 'daily') {
            if (!this.apiKey.trim()) {
                return;
            }
            
            this.modelStatsLoading = true;
            
            try {
                const response = await fetch('/apiStats/api/user-model-stats', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        apiKey: this.apiKey,
                        period: period
                    })
                });
                
                const result = await response.json();
                
                if (!response.ok) {
                    throw new Error(result.message || '加载模型统计失败');
                }
                
                if (result.success) {
                    this.modelStats = result.data || [];
                } else {
                    throw new Error(result.message || '加载模型统计失败');
                }
                
            } catch (error) {
                console.error('Load model stats error:', error);
                this.modelStats = [];
                // 不显示错误，因为模型统计是可选的
            } finally {
                this.modelStatsLoading = false;
            }
        },
        
        // 🔄 切换时间范围
        async switchPeriod(period) {
            if (this.statsPeriod === period || this.modelStatsLoading) {
                return;
            }
            
            this.statsPeriod = period;
            
            // 如果对应时间段的数据还没有加载，则加载它
            if ((period === 'daily' && !this.dailyStats) || 
                (period === 'monthly' && !this.monthlyStats)) {
                await this.loadPeriodStats(period);
            }
            
            // 加载对应的模型统计
            await this.loadModelStats(period);
        },
        
        // 📅 格式化日期
        formatDate(dateString) {
            if (!dateString) return '无';
            
            try {
                // 使用 dayjs 格式化日期
                const date = dayjs(dateString);
                return date.format('YYYY年MM月DD日 HH:mm');
            } catch (error) {
                return '格式错误';
            }
        },
        
        // 📅 格式化过期日期
        formatExpireDate(dateString) {
            if (!dateString) return '';
            const date = new Date(dateString);
            return date.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit'
            });
        },
        
        // 🔍 检查 API Key 是否已过期
        isApiKeyExpired(expiresAt) {
            if (!expiresAt) return false;
            return new Date(expiresAt) < new Date();
        },
        
        // ⏰ 检查 API Key 是否即将过期（7天内）
        isApiKeyExpiringSoon(expiresAt) {
            if (!expiresAt) return false;
            const expireDate = new Date(expiresAt);
            const now = new Date();
            const daysUntilExpire = (expireDate - now) / (1000 * 60 * 60 * 24);
            return daysUntilExpire > 0 && daysUntilExpire <= 7;
        },
        
        // 🔢 格式化数字
        formatNumber(num) {
            if (typeof num !== 'number') {
                num = parseInt(num) || 0;
            }
            
            if (num === 0) return '0';
            
            // 大数字使用简化格式
            if (num >= 1000000) {
                return (num / 1000000).toFixed(1) + 'M';
            } else if (num >= 1000) {
                return (num / 1000).toFixed(1) + 'K';
            } else {
                return num.toLocaleString();
            }
        },
        
        // 💰 格式化费用
        formatCost(cost) {
            if (typeof cost !== 'number' || cost === 0) {
                return '$0.000000';
            }
            
            // 根据数值大小选择精度
            if (cost >= 1) {
                return '$' + cost.toFixed(2);
            } else if (cost >= 0.01) {
                return '$' + cost.toFixed(4);
            } else {
                return '$' + cost.toFixed(6);
            }
        },
        
        // 🔐 格式化权限
        formatPermissions(permissions) {
            const permissionMap = {
                'claude': 'Claude',
                'gemini': 'Gemini', 
                'all': '全部模型'
            };
            
            return permissionMap[permissions] || permissions || '未知';
        },
        
        // 💾 处理错误
        handleError(error, defaultMessage = '操作失败') {
            console.error('Error:', error);
            
            let errorMessage = defaultMessage;
            
            if (error.response) {
                // HTTP 错误响应
                if (error.response.data && error.response.data.message) {
                    errorMessage = error.response.data.message;
                } else if (error.response.status === 401) {
                    errorMessage = 'API Key 无效或已过期';
                } else if (error.response.status === 403) {
                    errorMessage = '没有权限访问该数据';
                } else if (error.response.status === 429) {
                    errorMessage = '请求过于频繁，请稍后再试';
                } else if (error.response.status >= 500) {
                    errorMessage = '服务器内部错误，请稍后再试';
                }
            } else if (error.message) {
                errorMessage = error.message;
            }
            
            this.error = errorMessage;
        },
        
        // 📋 复制到剪贴板
        async copyToClipboard(text) {
            try {
                await navigator.clipboard.writeText(text);
                this.showToast('已复制到剪贴板', 'success');
            } catch (error) {
                console.error('Copy failed:', error);
                this.showToast('复制失败', 'error');
            }
        },
        
        // 🍞 显示 Toast 通知
        showToast(message, type = 'info') {
            // 简单的 toast 实现
            const toast = document.createElement('div');
            toast.className = `fixed top-4 right-4 z-50 px-6 py-3 rounded-lg shadow-lg text-white transform transition-all duration-300 ${
                type === 'success' ? 'bg-green-500' : 
                type === 'error' ? 'bg-red-500' : 
                'bg-blue-500'
            }`;
            toast.textContent = message;
            
            document.body.appendChild(toast);
            
            // 显示动画
            setTimeout(() => {
                toast.style.transform = 'translateX(0)';
                toast.style.opacity = '1';
            }, 100);
            
            // 自动隐藏
            setTimeout(() => {
                toast.style.transform = 'translateX(100%)';
                toast.style.opacity = '0';
                setTimeout(() => {
                    document.body.removeChild(toast);
                }, 300);
            }, 3000);
        },
        
        // 🧹 清除数据
        clearData() {
            this.statsData = null;
            this.modelStats = [];
            this.dailyStats = null;
            this.monthlyStats = null;
            this.error = '';
            this.statsPeriod = 'daily'; // 重置为默认值
        },
        
        // 🔄 刷新数据
        async refreshData() {
            if (this.statsData && this.apiKey) {
                await this.queryStats();
            }
        },
        
        // 📊 刷新当前时间段数据
        async refreshCurrentPeriod() {
            if (this.apiKey) {
                await this.loadPeriodStats(this.statsPeriod);
                await this.loadModelStats(this.statsPeriod);
            }
        }
    },
    
    computed: {
        // 📊 当前时间段的数据
        currentPeriodData() {
            if (this.statsPeriod === 'daily') {
                return this.dailyStats || {
                    requests: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreateTokens: 0,
                    cacheReadTokens: 0,
                    allTokens: 0,
                    cost: 0,
                    formattedCost: '$0.000000'
                };
            } else {
                return this.monthlyStats || {
                    requests: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreateTokens: 0,
                    cacheReadTokens: 0,
                    allTokens: 0,
                    cost: 0,
                    formattedCost: '$0.000000'
                };
            }
        },
        
        // 📊 使用率计算（基于当前时间段）
        usagePercentages() {
            if (!this.statsData || !this.currentPeriodData) {
                return {
                    tokenUsage: 0,
                    costUsage: 0,
                    requestUsage: 0
                };
            }
            
            const current = this.currentPeriodData;
            const limits = this.statsData.limits;
            
            return {
                tokenUsage: limits.tokenLimit > 0 ? Math.min((current.allTokens / limits.tokenLimit) * 100, 100) : 0,
                costUsage: limits.dailyCostLimit > 0 ? Math.min((current.cost / limits.dailyCostLimit) * 100, 100) : 0,
                requestUsage: limits.rateLimitRequests > 0 ? Math.min((current.requests / limits.rateLimitRequests) * 100, 100) : 0
            };
        },
        
        // 📈 统计摘要（基于当前时间段）
        statsSummary() {
            if (!this.statsData || !this.currentPeriodData) return null;
            
            const current = this.currentPeriodData;
            
            return {
                totalRequests: current.requests || 0,
                totalTokens: current.allTokens || 0,
                totalCost: current.cost || 0,
                formattedCost: current.formattedCost || '$0.000000',
                inputTokens: current.inputTokens || 0,
                outputTokens: current.outputTokens || 0,
                cacheCreateTokens: current.cacheCreateTokens || 0,
                cacheReadTokens: current.cacheReadTokens || 0
            };
        }
    },
    
    watch: {
        // 监听 API Key 变化
        apiKey(newValue) {
            if (!newValue) {
                this.clearData();
            }
            // 清除之前的错误
            if (this.error) {
                this.error = '';
            }
        }
    },
    
    mounted() {
        // 页面加载完成后的初始化
        console.log('User Stats Page loaded');
        
        // 检查 URL 参数是否有预填的 API Key（用于开发测试）
        const urlParams = new URLSearchParams(window.location.search);
        const presetApiKey = urlParams.get('apiKey');
        if (presetApiKey && presetApiKey.length > 10) {
            this.apiKey = presetApiKey;
        }
        
        // 添加键盘快捷键
        document.addEventListener('keydown', (event) => {
            // Ctrl/Cmd + Enter 查询
            if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
                if (!this.loading && this.apiKey.trim()) {
                    this.queryStats();
                }
                event.preventDefault();
            }
            
            // ESC 清除数据
            if (event.key === 'Escape') {
                this.clearData();
                this.apiKey = '';
            }
        });
        
        // 定期清理无效的 toast 元素
        setInterval(() => {
            const toasts = document.querySelectorAll('[class*="fixed top-4 right-4"]');
            toasts.forEach(toast => {
                if (toast.style.opacity === '0') {
                    try {
                        document.body.removeChild(toast);
                    } catch (e) {
                        // 忽略已经被移除的元素
                    }
                }
            });
        }, 5000);
    },
    
    // 组件销毁前清理
    beforeUnmount() {
        // 清理事件监听器
        document.removeEventListener('keydown', this.handleKeyDown);
    }
});

// 挂载应用
app.mount('#app');