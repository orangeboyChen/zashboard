// sing-box API(gRPC-Web,daemon.StartedService)的 Driver 实现。
//
// 与 clash driver 的「拉取式」不同,这里整体是「流驱动」的:
//   · proxies —— 订阅 SubscribeGroups / SubscribeOutbounds,每次推送重建共享状态,
//                因此选择 / 测速后无需手动刷新,结果随流自动回填。
//   · metrics —— 订阅 SubscribeStatus,一条 Status 扇出给 traffic / memory 两个消费者。
//   · connections —— 订阅 SubscribeConnections,把 protobuf 事件维护成活跃连接表。
//   · logs     —— 订阅 SubscribeLog,日志本就按批到达,直接整批产出。
//
// 无 gRPC 客户端(未连接 / 后端非 sing-box)时,所有读取返回空、所有写入静默丢弃,
// 以免旧会话的残留调用把新后端的数据打乱。
import { getSingboxClient, probeSingboxChannel } from '@/api/singbox/client'
import type { StreamHandle } from '@/api/singbox/streams'
import { subscribeStream } from '@/api/singbox/subscriptions'
import { apiVersion } from '@/assembly/backend'
import { defaultConfig } from '@/assembly/config'
import { activeConnections } from '@/assembly/connections'
import { proxyMap } from '@/assembly/proxies/state'
import { LOG_LEVEL } from '@/constant'
import {
  ConnectionEventType,
  LogLevel as PbLogLevel,
  type ConnectionEvents,
  type Group,
  type GroupItem,
  type Groups,
  type OutboundList,
  type Connection as PbConnection,
  type Log as PbLog,
  type Status,
} from '@/gen/daemon/started_service_pb'
import { getConnectionChains } from '@/helper'
import { automaticDisconnection, iconReflectList, speedtestTimeout } from '@/store/settings'
import { activeBackend } from '@/store/setup'
import type { Config, DNSQuery, HonkStats, Log, Proxy } from '@/types'
import { shallowRef, watch } from 'vue'
import type {
  ConnectionAccessor,
  ConnectionsPayload,
  Driver,
  MemorySample,
  MetricsHistory,
  ProxiesPayload,
  RulesPayload,
  Stream,
  TrafficSample,
} from './types'

const client = () => getSingboxClient()?.client

// ==========================================================================
// 连接字段访问器
// ==========================================================================

const asSingbox = (connection: unknown) => connection as PbConnection

// 拆分 "ip:port" / "[ipv6]:port"
const splitHostPort = (value: string): [string, string] => {
  if (!value) return ['', '']

  const idx = value.lastIndexOf(':')

  if (idx === -1) return [value, '']

  let host = value.slice(0, idx)
  const port = value.slice(idx + 1)

  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1)
  }

  return [host, port]
}

const getNetwork = (c: PbConnection) => {
  const [, destinationPort] = splitHostPort(c.destination || '')

  if ((destinationPort === '443' || c.domain) && c.network === 'udp') {
    return 'quic'
  }

  return c.network
}

const getHostname = (c: PbConnection) => c.domain || splitHostPort(c.destination || '')[0]

const accessor: ConnectionAccessor = {
  chains: (connection) => {
    const c = asSingbox(connection)

    return c.chainList.length ? c.chainList : [c.outbound].filter(Boolean)
  },
  download: (connection) => Number(asSingbox(connection).downlinkTotal),
  upload: (connection) => Number(asSingbox(connection).uplinkTotal),
  start: (connection) => Number(asSingbox(connection).createdAt),
  rule: (connection) => asSingbox(connection).rule || '',
  rulePayload: () => '',
  sourceIP: (connection) => splitHostPort(asSingbox(connection).source || '')[0],
  sourcePort: (connection) => splitHostPort(asSingbox(connection).source || '')[1],
  network: (connection) => getNetwork(asSingbox(connection)) || '',
  networkType: (connection) => {
    const c = asSingbox(connection)

    return `${c.inboundType} | ${getNetwork(c)}`
  },
  hostname: (connection) => getHostname(asSingbox(connection)),
  host: (connection) => {
    const c = asSingbox(connection)
    const [, destinationPort] = splitHostPort(c.destination)
    const host = getHostname(c)

    if (host.includes(':')) {
      return `[${host}]:${destinationPort}`
    }

    return `${host}:${destinationPort}`
  },
  process: (connection) => {
    const processInfo = asSingbox(connection).processInfo
    const processPath = processInfo?.processPath ?? ''

    return processInfo?.packageNames[0] || processPath.replace(/^.*[/\\](.*)$/, '$1') || '-'
  },
  destination: (connection) => {
    const c = asSingbox(connection)

    return splitHostPort(c.destination || '')[0] || c.domain || ''
  },
  inboundUser: (connection) => {
    const c = asSingbox(connection)

    return c.user || c.inbound || '-'
  },
  sniffHost: (connection) => asSingbox(connection).domain || '',
  remoteAddress: (connection) => asSingbox(connection).destination || '',
  isDirect: (connection) => asSingbox(connection).outboundType === 'direct',
  smartBlock: () => undefined,

  // sing-box 专属:protobuf 里确有这三个字段,连接详情与表格都有对应列。
  protocol: (connection) => asSingbox(connection).protocol || '',
  outboundType: (connection) => asSingbox(connection).outboundType || '',
  fromOutbound: (connection) => asSingbox(connection).fromOutbound || '',
}

// ==========================================================================
// 连接流
// ==========================================================================

// 订阅 gRPC SubscribeConnections:把 protobuf 事件维护成活跃连接表,并产出
// { connections, closed }。速率由事件自带的 uplinkDelta / downlinkDelta 得到,
// CLOSED 事件直接产出已关闭连接 —— 无需快照 diff。
const subscribeConnections = (): Stream<ConnectionsPayload> => {
  const data = shallowRef<ConnectionsPayload>()

  // 活跃连接表。每次变更都整体替换条目(immutable),不就地改写,
  // 因此 emit 直接产出表内引用即可,无需再拷贝。
  const conns = new Map<string, PbConnection>()
  // 本窗口新关闭的连接,emit 时随快照一并产出。
  let newlyClosed: PbConnection[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  const enrich = (c: PbConnection, down: number, up: number): PbConnection =>
    Object.assign({}, c, { downloadSpeed: down, uploadSpeed: up }) as PbConnection

  // 归入「本拍新关闭」并从活跃表移除。NEW/UPDATE/CLOSED 任意事件携带的连接,只要
  // closedAt > 0(初始快照里夹带的历史已关闭连接、或最终关闭快照)都走这里。
  const close = (id: string, base?: PbConnection) => {
    const c = base ?? conns.get(id)

    conns.delete(id)

    if (c) newlyClosed.push(enrich(c, 0, 0))
  }

  const emit = () => {
    timer = null

    data.value = {
      connections: Array.from(conns.values()) as ConnectionsPayload['connections'],
      closed: newlyClosed as ConnectionsPayload['connections'],
    }
    newlyClosed = []
  }

  const scheduleEmit = () => {
    if (timer) return

    timer = setTimeout(emit, 100)
  }

  const handle = subscribeStream<ConnectionEvents>('connections', (msg) => {
    if (msg.reset) {
      conns.clear()
    }

    for (const event of msg.events) {
      const downDelta = Number(event.downlinkDelta)
      const upDelta = Number(event.uplinkDelta)

      switch (event.type) {
        case ConnectionEventType.CONNECTION_EVENT_NEW:
          // NEW 事件不带 delta,速率记 0。初始快照可能把已关闭连接也当 NEW 下发。
          if (event.connection) {
            if (event.connection.closedAt > 0n) close(event.id, event.connection)
            else conns.set(event.id, enrich(event.connection, 0, 0))
          }
          break
        case ConnectionEventType.CONNECTION_EVENT_UPDATE: {
          if (event.connection) {
            if (event.connection.closedAt > 0n) close(event.id, event.connection)
            else conns.set(event.id, enrich(event.connection, downDelta, upDelta))
          } else {
            // 仅 delta:沿用上次的连接,累加总量,速率取本拍 delta。
            const prev = conns.get(event.id)

            if (prev) {
              conns.set(
                event.id,
                enrich(
                  {
                    ...prev,
                    uplinkTotal: prev.uplinkTotal + event.uplinkDelta,
                    downlinkTotal: prev.downlinkTotal + event.downlinkDelta,
                  },
                  downDelta,
                  upDelta,
                ),
              )
            }
          }
          break
        }
        case ConnectionEventType.CONNECTION_EVENT_CLOSED:
          // CLOSED 可能带最终快照;否则回退到活跃表内现有数据。
          close(event.id, event.connection)
          break
      }
    }

    scheduleEmit()
  })

  return {
    data,
    close: () => {
      if (timer) clearTimeout(timer)

      handle.close()
    },
  }
}

// ==========================================================================
// 代理:流驱动的状态机
// ==========================================================================

const getHistoryFromItem = (item: GroupItem): Proxy['history'] =>
  item.urlTestDelay > 0
    ? [
        {
          time: new Date(Number(item.urlTestTime) * 1000).toISOString(),
          delay: item.urlTestDelay,
        },
      ]
    : []

const nodeToProxy = (item: GroupItem): Proxy => ({
  name: item.tag,
  type: item.type,
  now: '',
  history: getHistoryFromItem(item),
  extra: {},
  icon: '',
})

let groups = new Map<string, Group>()
let outbounds = new Map<string, GroupItem>()
let handles: StreamHandle[] = []
let sessionKey = ''
let ready: Promise<void> | null = null

type URLTestWaiter = {
  resolve: () => void
  reject: (reason: Error) => void
  timer: ReturnType<typeof setTimeout>
}

const urlTestWaiters = new Set<URLTestWaiter>()

const resolveURLTestWaiters = () => {
  for (const waiter of urlTestWaiters) {
    clearTimeout(waiter.timer)
    waiter.resolve()
  }

  urlTestWaiters.clear()
}

const rejectURLTestWaiters = (reason: Error) => {
  for (const waiter of urlTestWaiters) {
    clearTimeout(waiter.timer)
    waiter.reject(reason)
  }

  urlTestWaiters.clear()
}

// URLTest RPC 只负责启动任务,延迟结果随后由 groups 流推送,所以这里等流而不等 RPC。
const waitForURLTestResult = (timeout: number) => {
  let waiter!: URLTestWaiter

  const promise = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => {
        urlTestWaiters.delete(waiter)
        reject(new Error('sing-box URL test result timeout'))
      },
      Math.max(5000, timeout) + 1000,
    )

    waiter = { resolve, reject, timer }
    urlTestWaiters.add(waiter)
  })

  return {
    promise,
    cancel: () => {
      clearTimeout(waiter.timer)
      urlTestWaiters.delete(waiter)
    },
  }
}

const rebuildProxies = (): ProxiesPayload => {
  const proxies: Record<string, Proxy> = {}

  // 1) 出站叶子节点(含延迟)
  for (const item of outbounds.values()) {
    proxies[item.tag] = nodeToProxy(item)
  }
  // 2) 用组内 items 补建缺失的叶子节点(outbounds 流可能晚到或不含某些成员)
  for (const group of groups.values()) {
    for (const item of group.items) {
      if (!proxies[item.tag]) proxies[item.tag] = nodeToProxy(item)
    }
  }
  // 3) 分组条目(携带 all / now),始终覆盖同名节点
  for (const group of groups.values()) {
    proxies[group.tag] = {
      name: group.tag,
      type: group.type,
      now: group.selected,
      all: group.items.map((i) => i.tag),
      selectable: group.selectable,
      history: [],
      extra: {},
      icon: '',
    }
  }
  // 4) 把组内 items 的延迟回填到叶子节点(绝不动带 all 的组条目)
  for (const group of groups.values()) {
    for (const item of group.items) {
      const node = proxies[item.tag]

      if (node && !node.all?.length && item.urlTestDelay > 0) {
        node.history = getHistoryFromItem(item)
      }
    }
  }
  // 5) 应用用户配置的「名称→图标」映射(sing-box 流不含图标)
  for (const iconReflect of iconReflectList.value) {
    const node = proxies[iconReflect.name]

    if (node) node.icon = iconReflect.icon
  }

  return {
    proxies,
    providers: [],
  }
}

const closeProxyStreams = () => {
  handles.forEach((h) => h.close())
  handles = []
  rejectURLTestWaiters(new Error('sing-box proxy stream closed'))
  sessionKey = ''
  ready = null
}

const stopProxies = () => {
  closeProxyStreams()
  groups = new Map()
  outbounds = new Map()
}

// 订阅两条流并维持共享状态。首次拿到 groups 之前 fetch 会 await,
// 保证调用方拿到的是非空快照而非半张表。
const ensureProxySession = () => {
  const backend = activeBackend.value
  const singboxClient = client()

  if (!backend || backend.type !== 'singbox' || !singboxClient) {
    stopProxies()
    return
  }

  if (sessionKey === backend.uuid && handles.length) return

  stopProxies()
  sessionKey = backend.uuid

  let resolveReady!: () => void
  let resolved = false

  ready = new Promise<void>((r) => (resolveReady = r))

  handles = [
    subscribeStream<Groups>('groups', (msg) => {
      groups = new Map()

      for (const g of msg.group) groups.set(g.tag, g)

      if (!resolved) {
        resolved = true
        resolveReady()
      } else {
        resolveURLTestWaiters()
      }
    }),
    subscribeStream<OutboundList>('outbounds', (msg) => {
      outbounds = new Map()

      for (const o of msg.outbounds) outbounds.set(o.tag, o)
    }),
  ]
}

const runURLTest = async (outboundTag: string, timeout = speedtestTimeout.value) => {
  ensureProxySession()

  if (ready) await ready

  const singboxClient = client()

  if (!singboxClient) return

  // 先注册等待,避免测速很快时结果推送早于一元 RPC 响应而丢失。
  const result = waitForURLTestResult(timeout)

  try {
    await Promise.all([singboxClient.uRLTest({ outboundTag }), result.promise])
  } finally {
    result.cancel()
  }
}

// ==========================================================================
// 日志
// ==========================================================================

const logLevelToType = (level: PbLogLevel): Log['type'] => {
  switch (level) {
    case PbLogLevel.PANIC:
      return LOG_LEVEL.Panic
    case PbLogLevel.FATAL:
      return LOG_LEVEL.Fatal
    case PbLogLevel.ERROR:
      return LOG_LEVEL.Error
    case PbLogLevel.WARN:
      return LOG_LEVEL.Warning
    case PbLogLevel.DEBUG:
      return LOG_LEVEL.Debug
    case PbLogLevel.TRACE:
      return LOG_LEVEL.Trace
    default:
      return LOG_LEVEL.Info
  }
}

// sing-box 的日志级别是「阈值」语义:级别数值越大越严重,故只放行 >= 选定级别的日志。
// silent 用 null 表示「全部丢弃」。
const logLevelFilterFromParam = (level?: string): PbLogLevel | null | undefined => {
  switch (level?.toLowerCase()) {
    case 'panic':
      return PbLogLevel.PANIC
    case 'fatal':
      return PbLogLevel.FATAL
    case 'error':
      return PbLogLevel.ERROR
    case 'warning':
    case 'warn':
      return PbLogLevel.WARN
    case 'info':
      return PbLogLevel.INFO
    case 'debug':
      return PbLogLevel.DEBUG
    case 'trace':
      return PbLogLevel.TRACE
    case 'silent':
      return null
    default:
      return undefined
  }
}

// ==========================================================================
// 指标:一条 Status 流扇出给 traffic / memory
// ==========================================================================

type StatusListener = (status: Status) => void

const statusListeners = new Set<StatusListener>()
let statusHandle: StreamHandle | null = null
let latestStatus: Status | null = null

const closeSharedStatusStream = () => {
  statusHandle?.close()
  statusHandle = null
  latestStatus = null
}

const subscribeStatus = <T>(
  map: (status: Status) => T,
  onValue: (value: T) => void,
): StreamHandle => {
  const listener: StatusListener = (status) => onValue(map(status))

  statusListeners.add(listener)

  if (!statusHandle) {
    statusHandle = subscribeStream<Status>('status', (status) => {
      latestStatus = status
      statusListeners.forEach((l) => l(status))
    })
  }

  if (latestStatus) listener(latestStatus)

  return {
    close: () => {
      statusListeners.delete(listener)

      if (statusListeners.size === 0) closeSharedStatusStream()
    },
  }
}

const wrapStatus = <T>(map: (status: Status) => T): Stream<T> => {
  const data = shallowRef<T>()
  const handle = subscribeStatus(map, (value) => (data.value = value))

  return { data, close: () => handle.close() }
}

// ==========================================================================
// Driver
// ==========================================================================

export const singboxDriver: Driver = {
  type: 'singbox',

  // 后端切换 / 登出时丢弃全部订阅,避免旧会话的流继续往共享状态里写。
  reset: () => {
    stopProxies()
    closeSharedStatusStream()
  },

  system: {
    probe: (backend, timeout, signal) => probeSingboxChannel(backend, timeout, signal),

    fetchVersion: async () => {
      const singboxClient = client()

      if (!singboxClient) return ''

      const version = await singboxClient.getVersion({})

      // apiVersion 是 usbip / openvpn / taildrop 三项能力的唯一来源。
      // probeActiveBackend() 每次会话都会把它清零,而 getVersion 是唯一能拿到
      // 真实值的地方,必须在这里写回共享 ref,否则那三项永远处于关闭状态。
      apiVersion.value = Number(version.apiVersion) || 0

      return version.version.includes('sing-box') ? version.version : `sing-box ${version.version}`
    },

    // 以下生命周期动作只有 Clash 通道提供,sing-box 侧静默丢弃。
    upgradeCore: () => Promise.resolve(),
    restartCore: () => Promise.resolve(),
    upgradeUI: () => Promise.resolve(),

    getStorage: async () => ({}),
    setStorage: () => Promise.resolve(),
    deleteStorage: () => Promise.resolve(),
  },

  metrics: {
    traffic: () =>
      wrapStatus<TrafficSample>((status) => ({
        down: Number(status.downlink),
        up: Number(status.uplink),
        downTotal: Number(status.downlinkTotal),
        upTotal: Number(status.uplinkTotal),
      })),

    memory: () =>
      wrapStatus<MemorySample>((status) => ({
        inuse: Number(status.memory),
      })),

    history: async (): Promise<MetricsHistory> => ({
      download: [],
      upload: [],
      memory: [],
      connections: [],
    }),

    fetchRuntimeStats: async (): Promise<HonkStats> => ({}) as HonkStats,
  },

  proxies: {
    fetch: async () => {
      ensureProxySession()

      if (ready) await ready

      return rebuildProxies()
    },

    select: async (group, name) => {
      const singboxClient = client()

      if (!singboxClient || proxyMap.value[group]?.selectable === false) return

      await singboxClient.selectOutbound({ groupTag: group, outboundTag: name })

      // 乐观更新,流随后会确认
      const target = groups.get(group)

      if (target) target.selected = name

      if (!automaticDisconnection.value) return

      const chains = getConnectionChains

      // 切换节点后断开命中该组的连接:Clash 侧由内核完成,sing-box 需主动发起。
      activeConnections.value
        .filter((connection) => chains(connection).includes(group))
        // 顺带动作,失败不该盖掉「已切换」这件主事
        .forEach((connection) => {
          singboxClient.closeConnection({ id: connection.id }).catch(() => {})
        })
    },

    // sing-box 的组没有「固定节点」概念
    clearFixed: () => Promise.resolve(),

    testNode: async (name, _url, timeout) => {
      await runURLTest(name, timeout ?? speedtestTimeout.value)

      return proxyMap.value[name]?.history.at(-1)?.delay ?? 0
    },

    testProviderNode: () => Promise.resolve(0),

    testGroup: async (group, _url, timeout) => {
      await runURLTest(group, timeout ?? speedtestTimeout.value)

      const result: Record<string, number> = {}

      for (const item of groups.get(group)?.items ?? []) {
        if (item.urlTestDelay > 0) result[item.tag] = item.urlTestDelay
      }

      return result
    },

    updateProvider: () => Promise.resolve(),
    healthCheckProvider: () => Promise.resolve(),
    fetchSmartWeights: async () => ({}),
    flushSmartWeights: () => Promise.resolve(),
  },

  rules: {
    // sing-box API 不暴露规则列表
    fetch: async (): Promise<RulesPayload> => ({ rules: [], providers: [] }),
    updateProvider: () => Promise.resolve(),
    toggleDisabled: () => Promise.resolve(),
  },

  config: {
    // 仅暴露 clash-mode,其余配置项保持默认
    fetch: async (): Promise<Config> => {
      const singboxClient = client()

      if (!singboxClient) return { ...defaultConfig }

      const status = await singboxClient.getClashModeStatus({})

      return {
        ...defaultConfig,
        mode: status.currentMode,
        'mode-list': status.modeList,
        modes: status.modeList,
      }
    },

    patch: async (config) => {
      const singboxClient = client()

      if (!singboxClient) return

      if (typeof config.mode === 'string') {
        await singboxClient.setClashMode({ mode: config.mode })
      }
    },

    reload: () => Promise.resolve(),
    load: () => Promise.resolve(),
    updateGeoData: () => Promise.resolve(),
    flushFakeIP: () => Promise.resolve(),
    flushDNSCache: () => Promise.resolve(),
    queryDNS: async (): Promise<DNSQuery> => ({}) as DNSQuery,
  },

  logs: {
    subscribe: (level, onBatch) => {
      const levelFilter = logLevelFilterFromParam(level)

      return subscribeStream<PbLog>('logs', (msg) => {
        const batch: Log[] = []

        for (const m of msg.messages) {
          if (levelFilter === null) continue
          if (levelFilter !== undefined && m.level > levelFilter) continue

          batch.push({ type: logLevelToType(m.level), payload: m.message })
        }

        if (batch.length) onBatch(batch)
      })
    },
  },

  connections: {
    accessor,
    subscribe: subscribeConnections,

    disconnect: async (id) => {
      const singboxClient = client()

      if (!singboxClient) return

      await singboxClient.closeConnection({ id })
    },

    disconnectAll: async () => {
      const singboxClient = client()

      if (!singboxClient) return

      await singboxClient.closeAllConnections({})
    },

    block: () => Promise.resolve(),
  },
}

// 供外部(如组装层的 watch)感知状态流是否活跃 —— 目前仅内部使用,导出以便调试。
export const isStatusStreamActive = () => statusListeners.size > 0

// watch 不是必须导出,这里保留引用以避免被 tree-shaking 误判为未使用
void watch
