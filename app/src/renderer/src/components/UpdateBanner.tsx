import {CloudDownloadOutlined, ReloadOutlined} from '@ant-design/icons'
import {Alert, Button, Progress, Space, Typography} from 'antd'
import {useEffect, useState} from 'react'
import type {UpdateState} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {bytes} from '../format'
import {useT} from '../i18n'

/** The updater's live state, from the main process. */
export function useUpdateState(): UpdateState {
  const [state, setState] = useState<UpdateState>({status: 'idle'})
  useEffect(() => {
    let alive = true
    void api()
      .updateState()
      .then(initial => alive && setState(initial))
    const off = api().onUpdate(setState)
    return () => {
      alive = false
      off()
    }
  }, [])
  return state
}

/**
 * Shown only when there is something to do: a new version (one button
 * downloads, verifies, installs and restarts), its progress, or a failure.
 */
export function UpdateBanner() {
  const t = useT()
  const {settings} = useApp()
  const state = useUpdateState()
  const [dismissed, setDismissed] = useState<string | undefined>()
  const lang = settings.language
  const open = (page: string) => window.open(page, '_blank', 'noopener')

  if (state.status === 'available' && dismissed !== state.version) {
    return (
      <Alert
        className="update-banner"
        data-testid="update-banner"
        type="info"
        showIcon
        icon={<CloudDownloadOutlined />}
        closable
        onClose={() => setDismissed(state.version)}
        message={t('update.available', {version: state.version})}
        description={t('update.availableHint', {size: bytes(state.size, lang)})}
        action={
          <Space direction="vertical" align="end">
            <Button type="primary" onClick={() => void api().installUpdate()}>
              {t('update.install')}
            </Button>
            <Typography.Link onClick={() => open(state.page)}>{t('update.whatsNew')}</Typography.Link>
          </Space>
        }
      />
    )
  }
  if (state.status === 'downloading') {
    const percent = state.total ? Math.floor((state.received / state.total) * 100) : 0
    return (
      <Alert
        className="update-banner"
        data-testid="update-banner"
        type="info"
        showIcon
        message={t('update.downloading', {version: state.version})}
        description={<Progress percent={percent} size="small" status="active" />}
      />
    )
  }
  if (state.status === 'installing' || state.status === 'ready') {
    return (
      <Alert
        className="update-banner"
        data-testid="update-banner"
        data-status={state.status}
        type="success"
        showIcon
        message={
          state.status === 'installing'
            ? t('update.installing', {version: state.version})
            : t('update.ready', {version: state.version})
        }
      />
    )
  }
  if (state.status === 'error' && state.version) {
    return (
      <Alert
        className="update-banner"
        data-testid="update-banner"
        type="error"
        showIcon
        closable
        message={t('update.failed')}
        description={state.message}
        action={
          <Space direction="vertical" align="end">
            <Button icon={<ReloadOutlined />} onClick={() => void api().installUpdate()}>
              {t('update.retry')}
            </Button>
            <Typography.Link onClick={() => open(state.page)}>{t('update.manual')}</Typography.Link>
          </Space>
        }
      />
    )
  }
  return null
}
