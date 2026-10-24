import {CloseOutlined, ScheduleOutlined} from '@ant-design/icons'
import {Alert, Button, Modal, Typography} from 'antd'
import {useState} from 'react'
import {detectLink} from '../../../shared/contract'
import {useApp} from '../context'
import {useT} from '../i18n'
import type {SiteLabel} from '../site'
import {Rows} from './Rows'
import {SiteTag} from './SiteTag'

type Link = {readonly url: string; readonly site: SiteLabel}

/**
 * Several links pasted or dropped at once, of any sites: review them (drop
 * any), then each becomes a batch with the format, quality and folder chosen
 * in the form. Each row says its site, detected once when the review opens.
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
  const {info} = useApp()
  const [links, setLinks] = useState<readonly Link[]>(() =>
    initial.map(url => {
      const found = detectLink(url, info.siteAliases)
      return {url, site: found?.file && found.site === 'web' ? 'file' : (found?.site ?? 'web')}
    }),
  )
  const urls = links.map(link => link.url)
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
        items={links}
        rowKey={(link, index) => `${index}:${link.url}`}
        render={(link, index) => (
          <>
            <SiteTag site={link.site} className="many-site" />
            <Typography.Text className="one-line mono" title={link.url}>
              {index + 1}. {link.url}
            </Typography.Text>
            <Button
              size="small"
              type="text"
              icon={<CloseOutlined />}
              aria-label={t('many.remove')}
              onClick={() => setLinks(links.filter((_, i) => i !== index))}
            />
          </>
        )}
      />
    </Modal>
  )
}
