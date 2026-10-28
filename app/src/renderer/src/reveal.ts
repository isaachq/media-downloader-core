import {App as AntApp} from 'antd'
import {useCallback} from 'react'
import {useT} from './i18n'
import {useAppStore} from './store'

/** Opens something of a batch now, or once the batch ends when it is still running. */
export type RevealLater = (batchId: string | undefined, open: () => void) => void

/**
 * "Show in folder" for a file of a batch still being written to: the tap says
 * "available when the batch finishes" and the store keeps it, so the folder
 * opens once when the batch ends, whatever tab is open then. A file of a
 * finished batch (or of none this session knows) opens at once. O(1) per tap.
 */
export function useRevealLater(): RevealLater {
  const t = useT()
  const {message} = AntApp.useApp()
  const store = useAppStore()
  return useCallback<RevealLater>(
    (batchId, open) => {
      if (store.revealWhenDone(batchId, open)) void message.info(t('finished.revealLater'))
      else open()
    },
    [store, message, t],
  )
}
