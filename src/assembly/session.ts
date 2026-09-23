import { activeBackend } from '@/store/setup'
import { watch } from 'vue'
import { can } from './backend'
import { fetchConfigs } from './config'
import { initConnections, stopConnections } from './connections'
import { fetchDaeRuntime } from './dae'
import { driver } from './driver'
import { initLogs, stopLogs } from './logs'
import { initSatistic, stopSatistic } from './overview'
import { fetchProxies } from './proxies'
import { fetchRules } from './rules'
import { probeActiveBackend } from './version'

const EVENT_DEBOUNCE = 400

let events: { close: () => void } | undefined
let refreshTimer: ReturnType<typeof setTimeout> | undefined

const scheduleRefresh = () => {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    fetchProxies().catch(() => {})
    fetchRules().catch(() => {})
    fetchConfigs().catch(() => {})
  }, EVENT_DEBOUNCE)
}

const stopEvents = () => {
  clearTimeout(refreshTimer)
  refreshTimer = undefined
  events?.close()
  events = undefined
}

const initEvents = () => {
  stopEvents()

  const subscribe = driver().events?.subscribe

  if (!subscribe || !can('backendEvents')) return

  events = subscribe((kind) => {
    if (kind === 'generation.changed') scheduleRefresh()
  })
}

// 世代号:startBackendSession 中途有 await,探测期间用户可能又切了后端甚至登出。
// 旧会话醒来必须让位 —— 否则它会用新后端的 driver 重建一遍流,
// 登出时更会让 driver() 回退到默认 clash 实现去解引用一个不存在的 activeBackend。
let generation = 0

export const startBackendSession = async () => {
  const current = ++generation

  stopConnections()
  stopLogs()
  stopSatistic()
  stopEvents()
  driver().reset?.()

  if (!activeBackend.value) {
    probeActiveBackend()
    return
  }

  await probeActiveBackend().catch(() => {})

  if (current !== generation) return

  fetchConfigs()
  fetchProxies()
  fetchRules()
  initConnections()
  initLogs()
  initSatistic()
  initEvents()

  if (activeBackend.value.type === 'dae') {
    fetchDaeRuntime().catch(() => {})
  }
}

watch(activeBackend, startBackendSession, { immediate: true })
