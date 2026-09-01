<template>
  <div
    class="bg-base-200/50 h-full w-full items-center justify-center overflow-auto sm:flex"
    @keydown.enter="handleSubmit(form)"
  >
    <div class="absolute top-4 right-4 max-sm:hidden">
      <DashboardSettings />
    </div>
    <div class="absolute right-4 bottom-4 max-sm:hidden">
      <LanguageSelect />
    </div>
    <div
      class="border-base-border bg-base-100 mx-auto flex w-96 max-w-[90%] flex-col gap-3 rounded-xl border px-6 py-5 shadow-none max-sm:my-4"
    >
      <h1 class="mb-1 text-lg">{{ $t('setup') }}</h1>

      <BackendForm v-model="form" />

      <ReachabilityIndicator
        class="min-h-5"
        :status="reachability.status.value"
        :latency="reachability.latency.value"
        :message="reachability.message.value"
        @retry="reachability.retry"
      />

      <button
        class="btn btn-primary btn-sm w-full"
        :disabled="!canSubmit"
        @click="handleSubmit(form)"
      >
        <span
          v-if="isSubmitting"
          class="loading loading-spinner loading-xs"
        ></span>
        {{ isSubmitting ? $t('backendConnecting') : $t('submit') }}
      </button>

      <!-- 已经存过后端却落到这里(当前后端被删、或存档里的 uuid 失效),
           给一条回到管理面板的路,而不是逼他把地址重填一遍。 -->
      <button
        v-if="backendList.length"
        class="btn btn-ghost btn-sm w-full"
        @click="openBackendManager()"
      >
        {{ $t('manageBackends') }}
      </button>

      <div class="mt-4 sm:hidden">
        <LanguageSelect />
      </div>
      <div class="absolute top-2 right-2 sm:hidden">
        <DashboardSettings />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { probeBackend } from '@/assembly/backend'
import DashboardSettings from '@/components/common/DashboardSettings.vue'
import ReachabilityIndicator from '@/components/common/ReachabilityIndicator.vue'
import BackendForm from '@/components/settings/backend/BackendForm.vue'
import LanguageSelect from '@/components/settings/general/LanguageSelect.vue'
import { ROUTE_NAME } from '@/constant'
import { syncSettingsFromCore } from '@/helper/autoImportSettings'
import { useBackendReachability } from '@/composables/backendReachability'
import { describeProbeFailure } from '@/helper/connectivity'
import { showNotification } from '@/helper/notification'
import { getBackendFromUrl, getBackendProbeUrl } from '@/helper/utils'
import router from '@/router'
import { addBackend, backendList, openBackendManager } from '@/store/setup'
import type { Backend, BackendType } from '@/types'
import { computed, ref, watch } from 'vue'

const form = ref<Omit<Backend, 'uuid'>>({
  type: 'clash' as BackendType,
  protocol: 'http',
  host: '127.0.0.1',
  port: '9090',
  secondaryPath: '',
  password: '',
  label: '',
})

// 填表期间就持续探测:通不通、为什么不通,在按提交之前就该看得见。
const reachability = useBackendReachability(form)

const isSubmitting = ref(false)
const canSubmit = computed(() => reachability.status.value === 'online' && !isSubmitting.value)

type SetupForm = Omit<Backend, 'uuid'>

const finishLogin = async () => {
  // 先切到 proxies 再同步:同步一旦被用户确认就会 location.reload(),
  // 那时 hash 还停在 #/setup 的话,刷新后就卡在设置页回不去面板。
  await router.push({ name: ROUTE_NAME.proxies })

  try {
    await syncSettingsFromCore()
  } catch (error) {
    console.error('Failed to sync settings after login:', error)
  }
}

// 提交 = 再确认一次连通性后存下并进入面板。
// 失败不再弹 alert:原因写在表单里的可达性指示器上,用户改哪个字段一目了然。
const handleSubmit = async (setupForm: SetupForm, quiet = false) => {
  const { protocol, host, port } = setupForm

  if (!protocol || !host || !port) return
  if (isSubmitting.value) return

  if (
    window.location.protocol === 'https:' &&
    protocol === 'http' &&
    !['::1', '0.0.0.0', '127.0.0.1', 'localhost'].includes(host) &&
    !quiet
  ) {
    showNotification({ content: 'protocolTips' })
  }

  isSubmitting.value = true

  try {
    const result = await probeBackend({ uuid: '', ...setupForm })

    if (!result.ok) {
      // 表单自身的失败已经由指示器呈现,让它重探一轮拿到最新结论即可;
      // URL 带来的后端不在表单里,只能单独提示。
      if (setupForm === form.value) {
        reachability.retry()
      } else if (!quiet) {
        showNotification({
          content: await describeProbeFailure(result, getBackendProbeUrl(setupForm)),
          type: 'alert-error',
        })
      }
      return
    }

    addBackend(setupForm)
    await finishLogin()
  } finally {
    isSubmitting.value = false
  }
}

const backend = getBackendFromUrl()

if (backend) {
  handleSubmit(backend)
} else if (backendList.value.length === 0) {
  // 一个后端都没有时,默认地址本来就通就别再让用户点一次 ——
  // 但只认首轮探测的结论,之后一律以用户的操作为准。
  const stopAutoLogin = watch(
    () => reachability.status.value,
    (status) => {
      if (status === 'checking') return
      stopAutoLogin()
      if (status === 'online') handleSubmit(form.value, true)
    },
  )
}
</script>
