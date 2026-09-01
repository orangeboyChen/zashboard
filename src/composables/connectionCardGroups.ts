import { computed, ref } from 'vue'

// 展开态由卡片列表维护、控制栏读写，两者不在同一棵组件树上，所以放模块级共享。
const groupIds = ref<string[]>([])
const expandedGroupIds = ref(new Set<string>())

export const expandedConnectionCardGroupIds = computed(() => expandedGroupIds.value)

export const hasExpandedConnectionCardGroups = computed(() =>
  groupIds.value.some((id) => expandedGroupIds.value.has(id)),
)

export const hasConnectionCardGroups = computed(() => groupIds.value.length > 0)

export const toggleConnectionCardGroup = (id: string) => {
  const next = new Set(expandedGroupIds.value)

  if (next.has(id)) next.delete(id)
  else next.add(id)

  expandedGroupIds.value = next
}

// 与代理页的整体折叠一致:只要还有展开的组就全部折叠,全折叠时才全部展开。
export const toggleAllConnectionCardGroups = () => {
  expandedGroupIds.value = hasExpandedConnectionCardGroups.value
    ? new Set()
    : new Set(groupIds.value)
}

export const resetConnectionCardGroups = () => {
  expandedGroupIds.value = new Set()
}

// 实时刷新只清掉已经消失的组，仍存在的组保持用户当前选择。
export const syncConnectionCardGroupIds = (ids: string[]) => {
  groupIds.value = ids

  const liveIds = new Set(ids)
  const retained = [...expandedGroupIds.value].filter((id) => liveIds.has(id))

  if (retained.length !== expandedGroupIds.value.size) {
    expandedGroupIds.value = new Set(retained)
  }
}
