import { readonly, ref } from 'vue'

export type ConfirmDialogOptions = {
  title?: string
  message: string
  link?: {
    text: string
    url: string
  }
  confirmText?: string
  cancelText?: string
  confirmButtonClass?: string
  checkboxText?: string
}

export type ConfirmDialogResult = {
  confirmed: boolean
  checked: boolean
}

type ConfirmDialogRequest = ConfirmDialogOptions & {
  resolve: (value: ConfirmDialogResult) => void
}

const activeConfirmDialog = ref<ConfirmDialogRequest>()
const confirmDialogQueue: ConfirmDialogRequest[] = []

const showNextConfirmDialog = () => {
  if (activeConfirmDialog.value || confirmDialogQueue.length === 0) return

  activeConfirmDialog.value = confirmDialogQueue.shift()
}

export const confirmDialogState = readonly(activeConfirmDialog)

export const showConfirmDialog = (options: ConfirmDialogOptions) => {
  return new Promise<ConfirmDialogResult>((resolve) => {
    confirmDialogQueue.push({
      ...options,
      resolve,
    })
    showNextConfirmDialog()
  })
}

export const resolveConfirmDialog = (confirmed: boolean, checked = false) => {
  const currentConfirmDialog = activeConfirmDialog.value
  if (!currentConfirmDialog) return

  activeConfirmDialog.value = undefined
  currentConfirmDialog.resolve({ confirmed, checked })
  showNextConfirmDialog()
}
