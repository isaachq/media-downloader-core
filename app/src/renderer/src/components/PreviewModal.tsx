import {CloudDownloadOutlined, CloudSyncOutlined, ReloadOutlined, SearchOutlined} from '@ant-design/icons'
import {Alert, Button, Flex, Input, InputNumber, Modal, Space, Table, Tag, Typography} from 'antd'
import type {PlaylistEntry} from 'media-downloader-core'
import {useMemo, useState} from 'react'
import type {Preview} from '../../../shared/contract'
import {useApp} from '../context'
import {clock, day} from '../format'
import {useT} from '../i18n'
import {AnalyzeLoader} from './AnalyzeLoader'

export type PlaylistPreview = Extract<Preview, {kind: 'playlist'}>

/** What the preview hands back: the picked entries, or the single video of a watch?v=…&list=… link. */
export type PreviewChoice =
  | {readonly kind: 'selection'; readonly title: string; readonly entries: readonly PlaylistEntry[]}
  | {readonly kind: 'video'; readonly url: string}

/** The engine's MAX_REQUESTED_ITEMS (the renderer doesn't load the engine). */
const MAX_ITEMS = 50_000

/** Seconds of the given entries, O(n). */
function totalSeconds(entries: Iterable<PlaylistEntry>): number {
  let seconds = 0
  for (const entry of entries) seconds += entry.duration ?? 0
  return seconds
}

/**
 * Everything a list holds, before anything is downloaded: pick all, some or
 * one; filter by title or channel; for a YouTube Mix choose how much of the
 * endless radio to load; for a profile that tells its size, load all of it
 * (listed chunk by chunk, with progress — a stopped load continues where it
 * was). Confirming schedules exactly the picked entries.
 */
export function PreviewModal({
  preview,
  loading,
  onReload,
  onStopReload,
  onConfirm,
  onCancel,
}: {
  readonly preview: PlaylistPreview
  readonly loading: boolean
  readonly onReload: (maxItems: number) => void
  readonly onStopReload: () => void
  readonly onConfirm: (choice: PreviewChoice) => void
  readonly onCancel: () => void
}) {
  const t = useT()
  const {settings} = useApp()
  const {entries} = preview
  const total = preview.total !== undefined ? Math.min(preview.total, MAX_ITEMS) : undefined
  const partial = total !== undefined && entries.length < total
  // the listing reached the end: the rest are posts the site counts but doesn't list — nothing to load
  const unlisted = partial && preview.complete === true
  // it stopped before the end and before the cap (refused, stalled): loading again continues
  const stopped = partial && !unlisted && entries.length < preview.maxItems
  const dated = useMemo(() => entries.some(entry => entry.publishedAt !== undefined), [entries])
  // selection by playlist index: stable while filtering, O(1) membership
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set(entries.map(entry => entry.index)))
  const [filter, setFilter] = useState('')
  const [cap, setCap] = useState(preview.maxItems)

  const visible = useMemo(() => {
    const needle = filter.trim().toLocaleLowerCase()
    if (!needle) return entries
    return entries.filter(
      entry =>
        entry.title.toLocaleLowerCase().includes(needle) || (entry.uploader ?? '').toLocaleLowerCase().includes(needle),
    )
  }, [entries, filter])

  const picked = useMemo(() => entries.filter(entry => selected.has(entry.index)), [entries, selected])
  const capped = preview.mix || partial || (total === undefined && entries.length >= preview.maxItems)

  const setVisible = (on: boolean) => {
    const next = new Set(selected)
    for (const entry of visible) {
      if (on) next.add(entry.index)
      else next.delete(entry.index)
    }
    setSelected(next)
  }

  return (
    <Modal
      open
      width={900}
      title={t('preview.title')}
      onCancel={onCancel}
      maskClosable={false}
      footer={
        <Flex justify="space-between" align="center" wrap gap={8}>
          <Typography.Text strong data-testid="preview-summary">
            {t('preview.selected', {
              count: picked.length,
              total: entries.length,
              duration: clock(totalSeconds(picked)) || '0:00',
            })}
          </Typography.Text>
          <Space wrap>
            {preview.singleVideoUrl ? (
              <Button onClick={() => onConfirm({kind: 'video', url: preview.singleVideoUrl!})}>
                {t('preview.onlyVideo')}
              </Button>
            ) : null}
            <Button onClick={onCancel}>{t('preview.cancel')}</Button>
            <Button
              type="primary"
              icon={<CloudDownloadOutlined />}
              disabled={picked.length === 0}
              onClick={() => onConfirm({kind: 'selection', title: preview.title, entries: picked})}
            >
              {t('preview.confirm', {count: picked.length})}
            </Button>
          </Space>
        </Flex>
      }
    >
      <Space direction="vertical" size="middle" className="full">
        <div>
          <Typography.Title level={5} className="preview-heading">
            {preview.mix ? <Tag color="purple">Mix</Tag> : null}
            {preview.title}
          </Typography.Title>
          <Typography.Text type="secondary">
            {[preview.uploader, t('preview.items', {count: entries.length, duration: clock(totalSeconds(entries))})]
              .filter(Boolean)
              .join(' · ')}
          </Typography.Text>
        </div>

        {unlisted ? (
          <Alert
            type="info"
            showIcon
            data-testid="preview-unlisted"
            message={t('preview.hidden', {
              count: entries.length,
              total: preview.total!,
              missing: preview.total! - entries.length,
            })}
          />
        ) : capped ? (
          <Alert
            type={preview.mix ? 'info' : 'warning'}
            showIcon
            message={
              preview.mix
                ? t('preview.mix', {count: entries.length})
                : stopped
                  ? t('preview.stopped', {count: entries.length, total: total!})
                  : partial
                    ? t('preview.partial', {count: entries.length, total: total!})
                    : t('preview.capped', {count: entries.length})
            }
            action={
              <Space wrap>
                {preview.mix ? null : (
                  // a known size loads exactly that; otherwise the listing runs to its end
                  <Button
                    type="primary"
                    icon={<CloudSyncOutlined />}
                    disabled={loading}
                    onClick={() => onReload(total ?? MAX_ITEMS)}
                    data-testid="preview-load-all"
                  >
                    {total !== undefined ? t('preview.loadAll', {total}) : t('preview.loadEverything')}
                  </Button>
                )}
                <Space.Compact>
                  <InputNumber
                    aria-label={t('preview.load')}
                    min={1}
                    max={MAX_ITEMS}
                    value={cap}
                    onChange={value => setCap(value ?? preview.maxItems)}
                    addonBefore={t('preview.load')}
                    style={{width: 190}}
                  />
                  <Button icon={<ReloadOutlined />} loading={loading} onClick={() => onReload(cap)}>
                    {t('preview.reload')}
                  </Button>
                </Space.Compact>
              </Space>
            }
          />
        ) : null}

        {loading ? <AnalyzeLoader onCancel={onStopReload} /> : null}

        <Flex gap={8} wrap>
          <Input
            allowClear
            prefix={<SearchOutlined />}
            aria-label={t('preview.search')}
            placeholder={t('preview.search')}
            value={filter}
            onChange={event => setFilter(event.target.value)}
            style={{flex: 1, minWidth: 220}}
          />
          <Button onClick={() => setVisible(true)}>{t('preview.all')}</Button>
          <Button onClick={() => setVisible(false)}>{t('preview.none')}</Button>
        </Flex>

        <Table<PlaylistEntry>
          size="small"
          rowKey="index"
          dataSource={[...visible]}
          pagination={false}
          virtual={visible.length > 100}
          scroll={{y: 380}}
          loading={loading}
          locale={{emptyText: t('preview.empty')}}
          rowSelection={{
            selectedRowKeys: [...selected],
            preserveSelectedRowKeys: true,
            onChange: keys => {
              // the table reports the visible rows' state; keep the hidden ones as they were
              const next = new Set(selected)
              for (const entry of visible) next.delete(entry.index)
              for (const key of keys) next.add(Number(key))
              setSelected(next)
            },
          }}
          onRow={entry => ({
            // the whole row toggles; the checkbox cell toggles by itself
            onClick: event => {
              if ((event.target as HTMLElement).closest('.ant-table-selection-column')) return
              const next = new Set(selected)
              if (next.has(entry.index)) next.delete(entry.index)
              else next.add(entry.index)
              setSelected(next)
            },
          })}
          columns={[
            {title: '#', dataIndex: 'index', width: 64},
            {title: t('preview.col.title'), dataIndex: 'title', ellipsis: true},
            {title: t('preview.col.channel'), dataIndex: 'uploader', width: 200, ellipsis: true},
            ...(dated
              ? [
                  {
                    title: t('preview.col.published'),
                    dataIndex: 'publishedAt',
                    width: 120,
                    render: (seconds: number | undefined) => day(seconds, settings.language),
                  },
                ]
              : []),
            {
              title: t('preview.col.duration'),
              dataIndex: 'duration',
              width: 90,
              align: 'right',
              render: (seconds: number | undefined) => clock(seconds),
            },
          ]}
        />
      </Space>
    </Modal>
  )
}
