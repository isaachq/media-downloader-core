import {Space, Tag, Typography} from 'antd'
import type {BatchSnapshot} from 'media-downloader-core'
import {MESSAGES, type MessageKey, type Translate, useT} from '../i18n'

type Counts = Readonly<Record<string, number>>

/** A cause's short label ("removed", "network"…); the raw cause when the app has no words for it. */
export function causeLabel(t: Translate, cause: string): string {
  const key = `cause.${cause}`
  return key in MESSAGES.en ? t(key as MessageKey) : cause
}

/** "network 2 · removed 1", most frequent first. */
export function causeText(t: Translate, counts: Counts): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([cause, count]) => `${causeLabel(t, cause)} ${count}`)
    .join(' · ')
}

/** Why items of a batch (or a whole run) didn't make it: failed downloads and unavailable items, by cause. */
export function Problems({problems}: {readonly problems: BatchSnapshot['problems']}) {
  const t = useT()
  if (!problems) return null
  const failed = Object.keys(problems.failed).length > 0
  const unavailable = Object.keys(problems.unavailable).length > 0
  if (!failed && !unavailable) return null
  return (
    <Space size={[6, 4]} wrap className="problems" data-testid="problems">
      {failed ? (
        <span>
          <Tag color="error">{t('batch.failedBy')}</Tag>
          <Typography.Text type="secondary">{causeText(t, problems.failed)}</Typography.Text>
        </span>
      ) : null}
      {unavailable ? (
        <span>
          <Tag color="warning">{t('batch.unavailableBy')}</Tag>
          <Typography.Text type="secondary">{causeText(t, problems.unavailable)}</Typography.Text>
        </span>
      ) : null}
    </Space>
  )
}
