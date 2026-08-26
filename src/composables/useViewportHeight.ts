import { onBeforeUnmount, onMounted } from 'vue'

type Tracker = { count: number; update: () => void }

const trackers = new Map<string, Tracker>()

export const acquireViewportHeight = (varName: string) => {
  const tracker = trackers.get(varName)

  if (tracker) {
    tracker.count++
    return
  }

  const update = () => {
    const viewport = window.visualViewport
    const height = viewport ? viewport.height : window.innerHeight
    document.documentElement.style.setProperty(varName, `${Math.round(height)}px`)
    if (viewport && viewport.offsetTop !== 0) window.scrollTo(0, 0)
  }

  trackers.set(varName, { count: 1, update })
  update()

  const viewport = window.visualViewport
  viewport?.addEventListener('resize', update)
  viewport?.addEventListener('scroll', update)
  window.addEventListener('resize', update)
}

export const releaseViewportHeight = (varName: string) => {
  const tracker = trackers.get(varName)

  if (!tracker) return

  tracker.count--
  if (tracker.count > 0) return

  trackers.delete(varName)

  const viewport = window.visualViewport
  viewport?.removeEventListener('resize', tracker.update)
  viewport?.removeEventListener('scroll', tracker.update)
  window.removeEventListener('resize', tracker.update)
  document.documentElement.style.removeProperty(varName)
}

export const useViewportHeight = (varName = '--app-height') => {
  onMounted(() => acquireViewportHeight(varName))
  onBeforeUnmount(() => releaseViewportHeight(varName))
}
