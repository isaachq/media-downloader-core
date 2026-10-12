import {CloseOutlined, ScheduleOutlined} from '@ant-design/icons'
import {Alert, Button, Modal, Typography} from 'antd'
import {useState} from 'react'
import {useT} from '../i18n'
import {Rows} from './Rows'

/**
 * Several links pasted or dropped at once: review them (drop any), then each
 * becomes a batch with the format, quality and folder chosen in the form.
 */
export function ManyLinksModal({
  urls: initial,
  repeated,
  onSchedule,
  onCancel,
}: {
  readonly urls: readonly string[]
  readonly repeated: number
  readonly onSchedule: (urls: readonly string[]) => Promise<void>
  readonly onCancel: () => void
}) {
  const t = useT()
  const [urls, setUrls] = useState(initial)
  const [busy, setBusy] = useState(false)
  return (
    <Modal
      open
      title={t('many.title', {count: urls.length})}
      onCancel={onCancel}
      mask={{closable: false}}
      width={760}
      footer={[
        <Button key="cancel" onClick={onCancel}>
          {t('preview.cancel')}
        </Button>,
        <Button
          key="go"
          type="primary"
          icon={<ScheduleOutlined />}
          loading={busy}
          disabled={urls.length === 0}
          onClick={async () => {
            setBusy(true)
            try {
              await onSchedule(urls)
            } finally {
              setBusy(false)
            }
          }}
          data-testid="many-schedule"
        >
          {t('many.schedule', {count: urls.length})}
        </Button>,
      ]}
    >
      <Alert type="info" showIcon title={t('many.hint')} className="many-hint" />
      {repeated > 0 ? (
        <Typography.Text type="secondary">{t('many.repeated', {count: repeated})}</Typography.Text>
      ) : null}
      <Rows
        className="many-list"
        items={urls}
        rowKey={(url, index) => `${index}:${url}`}
        render={(url, index) => (
          <>
            <Typography.Text className="one-line mono" title={url}>
              {index + 1}. {url}
            </Typography.Text>
            <Button
              size="small"
              type="text"
              icon={<CloseOutlined />}
              aria-label={t('many.remove')}
              onClick={() => setUrls(urls.filter((_, i) => i !== index))}
            />
          </>
        )}
      />
    </Modal>
  )
}
