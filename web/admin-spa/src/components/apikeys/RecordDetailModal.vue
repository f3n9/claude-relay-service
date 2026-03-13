<template>
  <el-dialog
    :append-to-body="true"
    class="record-detail-modal"
    :close-on-click-modal="false"
    :destroy-on-close="true"
    :model-value="show"
    :show-close="false"
    top="10vh"
    width="720px"
    @close="emitClose"
  >
    <template #header>
      <div class="flex items-center justify-between">
        <div>
          <p class="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
            请求详情
          </p>
          <p class="text-lg font-bold text-gray-900 dark:text-gray-100">
            {{ record?.model || '未知模型' }}
          </p>
        </div>
        <button
          aria-label="关闭"
          class="rounded-full p-2 text-gray-500 transition hover:bg-gray-100 hover:text-gray-700 dark:text-gray-300 dark:hover:bg-gray-800 dark:hover:text-gray-100"
          @click="emitClose"
        >
          <i class="fas fa-times" />
        </button>
      </div>
    </template>

    <div class="space-y-4">
      <div class="grid gap-3 md:grid-cols-2">
        <div
          class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900"
        >
          <h4 class="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-200">基本信息</h4>
          <ul class="space-y-2 text-sm text-gray-700 dark:text-gray-300">
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">时间</span>
              <span class="font-medium">{{ formattedTime }}</span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">模型</span>
              <span class="font-medium">{{ record?.model || '未知模型' }}</span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">账户</span>
              <span class="font-medium">{{ record?.accountName || '未知账户' }}</span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">渠道</span>
              <span class="font-medium">{{ record?.accountTypeName || '未知渠道' }}</span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">使用状态</span>
              <span class="font-medium">{{ record?.usageCaptureState || 'unknown' }}</span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">请求区域</span>
              <span class="font-medium">{{ record?.requestRegion || 'global' }}</span>
            </li>
          </ul>
        </div>

        <div
          class="rounded-lg border border-gray-200 bg-gray-50 p-4 dark:border-gray-800 dark:bg-gray-900"
        >
          <h4 class="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-200">Token 使用</h4>
          <ul class="space-y-2 text-sm text-gray-700 dark:text-gray-300">
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">输入 Token</span>
              <span class="font-semibold text-blue-600 dark:text-blue-400">
                {{ formatNumber(record?.inputTokens) }}
              </span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">输出 Token</span>
              <span class="font-semibold text-green-600 dark:text-green-400">
                {{ formatNumber(record?.outputTokens) }}
              </span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">缓存创建</span>
              <span class="font-semibold text-purple-600 dark:text-purple-400">
                {{ formatNumber(record?.cacheCreateTokens) }}
              </span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">缓存读取</span>
              <span class="font-semibold text-orange-600 dark:text-orange-400">
                {{ formatNumber(record?.cacheReadTokens) }}
              </span>
            </li>
            <li class="flex items-center justify-between">
              <span class="text-gray-500 dark:text-gray-400">总计</span>
              <span class="font-semibold text-gray-900 dark:text-gray-100">
                {{ formatNumber(record?.totalTokens) }}
              </span>
            </li>
          </ul>
        </div>
      </div>

      <div
        class="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-900"
      >
        <h4 class="mb-3 text-sm font-semibold text-gray-800 dark:text-gray-200">费用详情</h4>
        <div
          class="mb-4 space-y-2 rounded-md border border-gray-200 bg-gray-50 px-3 py-3 dark:border-gray-800 dark:bg-gray-800"
        >
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-500 dark:text-gray-400">
              当前展示费用（{{ displayCostLabel }}）
            </span>
            <span class="text-sm font-semibold text-yellow-600 dark:text-yellow-400">
              {{ displayCostText }}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-500 dark:text-gray-400">真实费用（对账）</span>
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {{ realCostText }}
            </span>
          </div>
          <div class="flex items-center justify-between">
            <span class="text-sm text-gray-500 dark:text-gray-400">额度费用（倍率后）</span>
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {{ ratedCostText }}
            </span>
          </div>
        </div>
        <h5 class="mb-3 text-xs font-semibold text-gray-600 dark:text-gray-300">
          分项费用（{{ breakdownModeLabel }}）
        </h5>
        <div class="grid gap-3 sm:grid-cols-2">
          <div
            class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
          >
            <span class="text-sm text-gray-500 dark:text-gray-400">输入费用</span>
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {{ formattedCosts.input }}
            </span>
          </div>
          <div
            class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
          >
            <span class="text-sm text-gray-500 dark:text-gray-400">输出费用</span>
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {{ formattedCosts.output }}
            </span>
          </div>
          <div
            class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
          >
            <span class="text-sm text-gray-500 dark:text-gray-400">缓存创建</span>
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {{ formattedCosts.cacheCreate }}
            </span>
          </div>
          <div
            class="flex items-center justify-between rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800"
          >
            <span class="text-sm text-gray-500 dark:text-gray-400">缓存读取</span>
            <span class="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {{ formattedCosts.cacheRead }}
            </span>
          </div>
        </div>
        <div
          class="mt-4 flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-4 py-3 dark:border-gray-800 dark:bg-gray-800"
        >
          <span class="text-sm font-semibold text-gray-700 dark:text-gray-200">分项总计</span>
          <div class="text-base font-bold text-yellow-600 dark:text-yellow-400">
            {{ formattedCosts.total }}
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="flex justify-end">
        <el-button type="primary" @click="emitClose">关闭</el-button>
      </div>
    </template>
  </el-dialog>
</template>

<script setup>
import { computed } from 'vue'
import dayjs from 'dayjs'
import { formatNumber } from '@/utils/tools'

const props = defineProps({
  show: {
    type: Boolean,
    default: false
  },
  record: {
    type: Object,
    default: () => ({})
  }
})

const emit = defineEmits(['close'])
const emitClose = () => emit('close')

const formatCost = (value) => {
  const num = typeof value === 'number' ? value : 0
  if (num >= 1) return `$${num.toFixed(2)}`
  if (num >= 0.001) return `$${num.toFixed(4)}`
  return `$${num.toFixed(6)}`
}

const normalizeCostValue = (value, fallback = 0) => {
  if (typeof value === 'number') {
    return value
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

const formattedTime = computed(() => {
  if (!props.record?.timestamp) return '未知时间'
  return dayjs(props.record.timestamp).format('YYYY-MM-DD HH:mm:ss')
})

const displayCostMode = computed(() => props.record?.displayCostMode || 'real')
const realCost = computed(() => normalizeCostValue(props.record?.realCost, 0))
const ratedCost = computed(() =>
  normalizeCostValue(
    props.record?.ratedCost,
    normalizeCostValue(props.record?.cost, realCost.value)
  )
)
const displayCost = computed(() =>
  normalizeCostValue(
    props.record?.displayCost,
    displayCostMode.value === 'rated' ? ratedCost.value : realCost.value
  )
)

const displayCostLabel = computed(() =>
  displayCostMode.value === 'rated' ? '额度费用（倍率后）' : '真实费用（对账）'
)
const displayCostText = computed(
  () =>
    props.record?.displayCostFormatted ||
    props.record?.costFormatted ||
    formatCost(displayCost.value)
)
const realCostText = computed(() => props.record?.realCostFormatted || formatCost(realCost.value))
const ratedCostText = computed(
  () => props.record?.ratedCostFormatted || formatCost(ratedCost.value)
)

const breakdownModeLabel = computed(() =>
  props.record?.realCostBreakdown ? '真实费用口径' : '当前记录口径'
)

const formattedCosts = computed(() => {
  const breakdown = props.record?.realCostBreakdown || props.record?.costBreakdown || {}

  return {
    input: formatCost(normalizeCostValue(breakdown.input, 0)),
    output: formatCost(normalizeCostValue(breakdown.output, 0)),
    cacheCreate: formatCost(normalizeCostValue(breakdown.cacheCreate, 0)),
    cacheRead: formatCost(normalizeCostValue(breakdown.cacheRead, 0)),
    total: formatCost(
      normalizeCostValue(
        breakdown.total,
        props.record?.realCostBreakdown ? realCost.value : displayCost.value
      )
    )
  }
})
</script>

<style scoped>
.record-detail-modal :deep(.el-dialog__header) {
  margin: 0;
  padding: 16px 16px 0;
}

.record-detail-modal :deep(.el-dialog__body) {
  padding: 12px 16px 4px;
}

.record-detail-modal :deep(.el-dialog__footer) {
  padding: 8px 16px 16px;
}
</style>
