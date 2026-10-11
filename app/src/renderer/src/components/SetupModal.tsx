import {CheckCircleFilled, CloseCircleFilled, ExclamationCircleFilled} from '@ant-design/icons'
import {Alert, Button, List, Modal, Progress, Space, Tag, Typography} from 'antd'
import type {Diagnosis, InstallProgress} from 'media-downloader-core'
import {useEffect, useState} from 'react'
import {api} from '../api'
import {type MessageKey, useT} from '../i18n'

type Props = {
  readonly open: boolean
  readonly diagnosis: Diagnosis | undefined
  /** Reinstall even if everything looks fine. */
  readonly force: boolean
  readonly onDone: (diagnosis: Diagnosis) => void
  readonly onClose: () => void
}

const ICON = {
  ok: <CheckCircleFilled style={{color: 'var(--ok)'}} />,
  warn: <ExclamationCircleFilled style={{color: 'var(--warn)'}} />,
  fail: <CloseCircleFilled style={{color: 'var(--bad)'}} />,
} as const

/** First-run (or repair) setup: what's missing, then a verified install with live progress. */
export function SetupModal({open, diagnosis, force, onDone, onClose}: Props) {
  const t = useT()
  const [installing, setInstalling] = useState(false)
  const [progress, setProgress] = useState<InstallProgress | undefined>()
  const [error, setError] = useState<string | undefined>()
  const [current, setCurrent] = useState<Diagnosis | undefined>(diagnosis)

  useEffect(() => setCurrent(diagnosis), [diagnosis])
  useEffect(() => api().onSetupProgress(setProgress), [])

  const install = async () => {
    setInstalling(true)
    setError(undefined)
    try {
      const outcome = await api().setup(force)
      setCurrent(outcome.diagnosis)
      if (outcome.ready) onDone(outcome.diagnosis)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    } finally {
      setInstalling(false)
      setProgress(undefined)
    }
  }

  const ready = current?.ready === true && !installing
  const transfer = progress?.transfer
  const percent = transfer?.total ? Math.round((transfer.received / transfer.total) * 100) : undefined

  return (
    <Modal
      // above the drawers: "Diagnose" / "Reinstall" are launched from Settings, which stays open behind
      zIndex={1100}
      open={open}
      title={t('setup.title')}
      closable={ready}
      maskClosable={false}
      onCancel={onClose}
      footer={
        ready ? (
          <Button type="primary" onClick={onClose}>
            {t('setup.continue')}
          </Button>
        ) : (
          <Button type="primary" loading={installing} onClick={() => void install()} data-testid="setup-install">
            {installing ? t('setup.installing') : t('setup.install')}
          </Button>
        )
      }
    >
      <Space direction="vertical" className="full">
        <Typography.Paragraph>{t('setup.intro')}</Typography.Paragraph>
        {current ? (
          <List
            size="small"
            dataSource={[...current.tools]}
            renderItem={tool => (
              <List.Item>
                <Space>
                  {ICON[tool.state]}
                  <Typography.Text strong>{tool.name}</Typography.Text>
                  {tool.version ? <Tag>{tool.version}</Tag> : null}
                  <Typography.Text type="secondary">
                    {t(tool.state === 'ok' ? 'doctor.ok' : tool.state === 'warn' ? 'doctor.warn' : 'doctor.fail')}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        ) : null}
        {progress ? (
          <Space direction="vertical" className="full" data-testid="setup-progress">
            <Typography.Text>
              {progress.tool} {progress.version ?? ''} — {t(`setup.stage.${progress.stage}` as MessageKey)}
              {progress.asset ? ` · ${progress.asset}` : ''}
            </Typography.Text>
            <Progress percent={percent ?? 0} status="active" showInfo={percent !== undefined} />
          </Space>
        ) : null}
        {ready ? <Alert type="success" showIcon message={t('setup.ready')} /> : null}
        {error ? <Alert type="error" showIcon message={t('setup.failed', {message: error})} /> : null}
      </Space>
    </Modal>
  )
}
