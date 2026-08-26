import { onBeforeUnmount, onMounted, ref } from 'vue'

export const useKeyboardInset = () => {
  const inset = ref(0)

  const update = () => {
    const viewport = window.visualViewport
    if (!viewport) return

    const height = window.innerHeight - viewport.height - viewport.offsetTop
    inset.value = height > 1 ? Math.round(height) : 0
  }

  onMounted(() => {
    const viewport = window.visualViewport
    if (!viewport) return

    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
  })

  onBeforeUnmount(() => {
    window.visualViewport?.removeEventListener('resize', update)
    window.visualViewport?.removeEventListener('scroll', update)
  })

  return inset
}
