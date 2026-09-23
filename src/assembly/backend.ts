import type { ProbeResult } from '@/helper/connectivity'
import { displayAllFeatures } from '@/store/settings'
import { activeBackend } from '@/store/setup'
import type { Backend } from '@/types'
import { computed, ref } from 'vue'
import { daeCapabilities } from './capabilities'
import { driverFor } from './driver'

// usbip 需要 sing-box gRPC API v2(ProvideUSBDevices 流)
const USBIP_MIN_API_VERSION = 2
// OpenVPN 需要 sing-box gRPC API v3(SubscribeOpenVPNStatus 流)
const OPENVPN_MIN_API_VERSION = 3
// Taildrop 需要 sing-box gRPC API v4(SubscribeTaildropInbox / SendTaildropFiles 等)
const TAILDROP_MIN_API_VERSION = 4

export enum Channel {
  Clash = 'clash',
  Singbox = 'singbox',
}

export enum Core {
  Mihomo = 'mihomo',
  Singbox = 'singbox',
  Honk = 'honk',
  Dae = 'dae',
  Unknown = 'unknown',
}

export const channel = computed<Channel>(() =>
  activeBackend.value?.type === 'singbox' ? Channel.Singbox : Channel.Clash,
)

// core / apiVersion 由 assembly/version.ts 在探测 /version 后写入,
// 后端切换时先重置为未知,避免沿用上一个后端的结论。
export const core = ref<Core>(Core.Unknown)
export const apiVersion = ref(0)

export const resetCore = () => {
  core.value = Core.Unknown
  apiVersion.value = 0
}

// displayAllFeatures 的适用范围:Clash 通道上跑着非 mihomo 内核(sing-box / honk)时。
// 该开关的语义是「我用的 fork 版内核也支持这些 mihomo 扩展端点,先显示出来」——
// 只有在 Clash 通道上,那些端点才有可能存在。sing-box API(gRPC)通道上它们压根不是
// 同一套协议,掰开只会打出必然失败的请求,所以那里既不显示开关,存量的 true 也不生效。
// core 未探测出结论(Unknown)时不掰,免得凭空点亮一堆按钮。
const isNonMihomoClashCore = computed(
  () =>
    channel.value === Channel.Clash && (core.value === Core.Singbox || core.value === Core.Honk),
)

const isForkCoreOverride = computed(() => isNonMihomoClashCore.value && displayAllFeatures.value)

// 开关自身的可见性与其生效范围保持一致。
export const showDisplayAllFeatures = computed(
  () => !!activeBackend.value && isNonMihomoClashCore.value,
)

export type Cap =
  | 'rules'
  | 'coreUpgrade'
  | 'coreRestart'
  | 'dashboardUpgrade'
  | 'reloadConfigs'
  | 'updateConfigs'
  | 'updateGeoDatabase'
  | 'syncSettings'
  | 'independentLatency'
  | 'coreUpdateCheck'
  | 'configPatch'
  | 'traceLogLevel'
  | 'silentLogLevel'
  | 'runtimeStats'
  | 'latencyTest'
  | 'proxyProviderUpdate'
  | 'proxyProviderHealthCheck'
  | 'ruleProviders'
  | 'flushDNSCache'
  | 'flushFakeIP'
  | 'dnsQuery'
  | 'connectionsClose'
  | 'connectionsFilterClose'
  | 'customTestUrl'
  | 'nodeLatencyTest'
  | 'metricsHistory'
  | 'backendEvents'
  | 'flows'
  | 'dnsCache'
  | 'dnsLog'
  | 'routingTrace'
  | 'datapath'
  | 'runtimeSettings'
  | 'configSources'
  | 'configEdit'
  | 'entryManage'
  | 'groupConfigPatch'
  | 'lifecycleControl'
  // ---------- sing-box 通道专属 ----------
  // 以下各项由 channel / apiVersion 决定:确定事实,不随 displayAllFeatures 掰开。
  // 自定义全局节点
  | 'customGlobalNode'
  // sing-box 日志 payload 带 "[type]:" 前缀,可据此做类型分面过滤
  | 'logTypeFilter'
  // sing-box 日志以 "[连接id 耗时]" 开头,可据此从日志跳到对应连接
  | 'logConnectionDetail'
  // sing-box 切换模式后需要主动断开命中 clash_mode 规则的连接
  | 'disconnectOnModeChange'
  // fatal / panic 日志级别:仅 sing-box 支持
  | 'extraLogLevels'
  | 'tools'
  | 'goroutines'
  | 'startedAt'
  | 'usbip'
  | 'openvpn'
  | 'taildrop'

type Caps = Partial<Record<Cap, boolean>>

const clashCaps = computed<Caps>(() => {
  const mihomo = core.value === Core.Mihomo
  const honk = core.value === Core.Honk
  const mihomoOrForkCore = mihomo || isForkCoreOverride.value

  return {
    rules: true,

    coreUpgrade: mihomoOrForkCore,
    coreRestart: mihomoOrForkCore,
    dashboardUpgrade: mihomoOrForkCore,
    reloadConfigs: mihomoOrForkCore,
    updateConfigs: mihomoOrForkCore,
    updateGeoDatabase: mihomoOrForkCore,
    syncSettings: mihomoOrForkCore,
    independentLatency: mihomoOrForkCore,
    coreUpdateCheck: mihomo,
    configPatch: mihomo,

    traceLogLevel: honk,
    silentLogLevel: mihomo,

    runtimeStats: honk,

    latencyTest: true,
    proxyProviderUpdate: true,
    proxyProviderHealthCheck: true,
    ruleProviders: true,
    flushDNSCache: true,
    flushFakeIP: true,
    dnsQuery: true,
    connectionsClose: true,
    customTestUrl: true,
    nodeLatencyTest: true,
  }
})

const daeCaps = computed<Caps>(() => {
  const resources = daeCapabilities.value?.resources

  return {
    rules: true,

    reloadConfigs: resources?.reload.available === true,
    updateGeoDatabase: resources?.geodata.can_update === true,

    traceLogLevel: resources?.logs.levels?.includes('trace') === true,

    runtimeStats: resources?.runtime_outbounds.available === true,

    latencyTest: resources?.probes.available === true,
    proxyProviderUpdate: resources?.providers.can_refresh === true,
    flushDNSCache: resources?.dns_cache.flush === true,
    dnsQuery: resources?.dns_query.available === true,
    connectionsClose: resources?.connections.can_close === true,
    connectionsFilterClose: resources?.connections.can_close === true,
    metricsHistory:
      resources?.traffic_history.available === true || resources?.memory_history.available === true,
    backendEvents: resources?.events.available === true,
    flows: resources?.flows.available === true,
    dnsCache: resources?.dns_cache.read === true,
    dnsLog: resources?.dns_log.available === true,
    routingTrace: resources?.routing_trace.available === true,
    datapath: resources?.datapath.available === true,
    runtimeSettings: resources?.runtime_settings.available === true,
    configSources: resources?.config.available === true,
    configEdit: resources?.config.writable === true && resources?.config.content === true,
    entryManage: resources?.nodes.can_manage === true || resources?.providers.can_manage === true,
    groupConfigPatch: resources?.groups.config_patch === true,
    lifecycleControl: resources?.suspend.available === true && resources?.resume.available === true,
  }
})

// sing-box API(gRPC)通道的能力:由 channel 与 apiVersion 决定的硬事实。
// 这里的每一项都不依赖 /version 嗅探出的 core,因此不受 displayAllFeatures 影响。
const singboxCaps = computed<Caps>(() => {
  const connected = !!activeBackend.value

  return {
    customGlobalNode: connected,
    logTypeFilter: connected,
    logConnectionDetail: connected,
    disconnectOnModeChange: connected,
    extraLogLevels: connected,
    traceLogLevel: connected,
    silentLogLevel: connected,

    // sing-box 的 clash-mode 由 setClashMode 切换,driver 已实现 config.patch,
    // 模式选择器据此显示(见 ProxiesCtrl 的 can('configPatch') 门控)。
    configPatch: connected,

    tools: connected,
    goroutines: connected,
    startedAt: connected,
    usbip: connected && apiVersion.value >= USBIP_MIN_API_VERSION,
    openvpn: connected && apiVersion.value >= OPENVPN_MIN_API_VERSION,
    taildrop: connected && apiVersion.value >= TAILDROP_MIN_API_VERSION,

    latencyTest: true,
    proxyProviderUpdate: true,
    proxyProviderHealthCheck: true,
    nodeLatencyTest: true,
    connectionsClose: true,
    customTestUrl: true,
  }
})

const soft = computed<Caps>(() => {
  const type = activeBackend.value?.type

  if (type === 'dae') return daeCaps.value
  if (type === 'singbox') return singboxCaps.value

  return clashCaps.value
})

export const can = (cap: Cap): boolean => {
  if (!activeBackend.value) return false

  return soft.value[cap] === true
}

// 后端连通性探测(供 Setup / EditBackend / 连接失败页使用)。
// 按后端类型分派到对应 driver 的 probe,结果形状统一成 ProbeResult。
export const probeBackend = (
  backend: Backend,
  timeout: number = 10000,
  signal?: AbortSignal,
): Promise<ProbeResult> => driverFor(backend).system.probe(backend, timeout, signal)

export const isBackendAvailable = (backend: Backend, timeout: number = 10000) =>
  probeBackend(backend, timeout).then((result) => result.ok)
