import { onUnmounted, ref, watch, type Ref } from 'vue'

// How many dialogs are currently visible. Page-level gestures read this instead
// of querying the DOM — DialogWrapper renders a plain <div>, not a native
// <dialog> — and dialogs nest (ConnectionDetails opens SourceIPLabels), so a
// boolean flag would be cleared by the inner one closing while the outer is up.
export const openDialogCount = ref(0)

export const useDialogOpenState = (isOpen: Ref<boolean | undefined>) => {
  let held = false

  const acquire = () => {
    if (held) return
    held = true
    openDialogCount.value++
  }

  const release = () => {
    if (!held) return
    held = false
    openDialogCount.value--
  }

  watch(isOpen, (val) => (val ? acquire() : release()), { immediate: true })
  // A dialog can be unmounted by `v-if` while still open; hand the count back so
  // it never leaks and permanently disables page swiping.
  onUnmounted(release)
}
