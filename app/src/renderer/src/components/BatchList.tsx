import {
  ClearOutlined,
  ClockCircleOutlined,
  FolderOpenOutlined,
  StopOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import {Button, Card, Empty, Flex, Popconfirm, Progress, Space, Table, Tag, Typography} from 'antd'
import type {BatchId, BatchSnapshot, PreflightItem} from 'media-downloader-core'
import {memo, useCallback, useEffect, useMemo, useState} from 'react'
import {api} from '../api'
import {useApp} from '../context'
import {bytes, clock, finishesAt, timeLeft} from '../format'
import {type MessageKey, useT} from '../i18n'
import {BATCH_FINISHED, useAppStore, useStore} from '../store'

const STATUS_COLOR: Readonly<Record<BatchSnapshot['status'], string>> = {
  scheduled: 'default',
  checking: 'processing',
  running: 'processing',
  completed: 'success',
  'completed-with-errors': 'warning',
  failed: 'error',
  cancelled: 'warning',
}
const PAGE = 50

/** Items of one batch, fetched a page at a time from the main process and patched live. */
function BatchItems({batchId}: {readonly batchId: BatchId}) {
  const t = useT()
  const {settings} = useApp()
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<PreflightItem[]>([])
  const store = useAppStore()
  const total = store.batches.get(batchId)?.preflight.total ?? 0

  const load = useCallback(async () => setRows(await api().items(batchId, (page - 1) * PAGE, PAGE)), [batchId, page])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(
    () =>
      store.onItem(batchId, item => setRows(current => current.map(row => (row.index === item.index ? item : row)))),
    [batchId, store],
  )

  return (
    <Table<PreflightItem>
      size="small"
      rowKey="index"
      dataSource={rows}
      pagination={{current: page, pageSize: PAGE, total, onChange: setPage, showSizeChanger: false}}
      columns={[
        {title: '#', dataIndex: 'index', width: 60},
        {title: t('job.title'), key: 'title', ellipsis: true, render: (_, item) => item.title ?? item.url},
        {title: '⏱', key: 'duration', width: 80, render: (_, item) => clock(item.duration)},
        {title: '⛁', key: 'size', width: 100, render: (_, item) => bytes(item.estimatedBytes, settings.language)},
        {
          title: t('job.status'),
          key: 'state',
          width: 260,
          render: (_, item) => (
            <Space size={4} wrap>
              <Tag color={item.state === 'ok' ? 'success' : item.state === 'unavailable' ? 'error' : 'processing'}>
                {t(`item.state.${item.state}` as MessageKey)}
              </Tag>
              {item.archived ? <Tag color="cyan">{t('item.archived')}</Tag> : null}
              {item.tier && item.tier !== 'normal' ? (
                <Tag color="gold">{t(`job.tier.${item.tier}` as MessageKey)}</Tag>
              ) : null}
              {item.error ? (
                <Typography.Text type="danger">
                  {item.error.hint ? t(`hint.${item.error.hint}` as MessageKey) : item.error.message}
                </Typography.Text>
              ) : null}
            </Space>
          ),
        },
      ]}
    />
  )
}

// snapshots are immutable and replaced only when their batch changes: unchanged cards skip rendering
const BatchCard = memo(function BatchCard({batch}: {readonly batch: BatchSnapshot}) {
  const t = useT()
  const {settings} = useApp()
  const [open, setOpen] = useState(false)
  const lang = settings.language
  const {preflight, jobs, estimate} = batch
  const done = jobs.succeeded + jobs.failed
  const finished = ['completed', 'completed-with-errors', 'failed', 'cancelled'].includes(batch.status)
  const percent =
    batch.status === 'checking'
      ? Math.round((preflight.checked / Math.max(1, preflight.total)) * 100)
      : batch.progress
        ? Math.floor(batch.progress.fraction * 100) // weighted by size, includes running downloads
        : Math.round((done / Math.max(1, jobs.total)) * 100)
  const eta = batch.status === 'running' ? batch.progress?.etaSeconds : undefined

  return (
    <Card size="small" className="batch-card" data-testid="batch-card" data-status={batch.status}>
      <Flex justify="space-between" align="start" gap={12}>
        <Space direction="vertical" size={2} className="full">
          <Space wrap>
            <Tag color={STATUS_COLOR[batch.status]} data-testid="batch-status">
              {t(`batch.status.${batch.status}` as MessageKey)}
            </Tag>
            {batch.kind ? <Tag>{t(batch.kind === 'playlist' ? 'batch.playlist' : 'batch.video')}</Tag> : null}
            {batch.position ? <Tag>{t('batch.position', {position: batch.position})}</Tag> : null}
            {/* CSS ellipsis: Ant Design's measured ellipsis reads layout on every render */}
            <Typography.Text strong className="batch-title one-line" title={batch.title ?? batch.url}>
              {batch.title ?? batch.url}
            </Typography.Text>
          </Space>
          <Typography.Text type="secondary" className="mono">
            {batch.id}
          </Typography.Text>
          {preflight.total ? (
            <Typography.Text type="secondary">
              {t('batch.preflight', {
                checked: preflight.checked,
                total: preflight.total,
                ok: preflight.ok,
                unavailable: preflight.unavailable,
              })}
            </Typography.Text>
          ) : null}
          {estimate ? (
            <Typography.Text type="secondary" data-testid="batch-forecast">
              {t('batch.forecast', {
                bytes: bytes(estimate.bytes, lang),
                required: bytes(estimate.requiredBytes, lang),
                free: bytes(estimate.freeBytes, lang),
              })}
              {estimate.long || estimate.heavy
                ? ` · ${t('batch.forecastLong', {long: estimate.long, heavy: estimate.heavy})}`
                : ''}
              {estimate.archived ? ` · ${t('batch.archived', {count: estimate.archived})}` : ''}
            </Typography.Text>
          ) : null}
          {jobs.total ? (
            <Typography.Text>
              {t('batch.progress', {
                succeeded: jobs.succeeded,
                total: jobs.total,
                running: jobs.running,
                failed: jobs.failed,
              })}
            </Typography.Text>
          ) : null}
          {batch.status === 'running' ? (
            <Typography.Text data-testid="batch-eta" className="batch-eta">
              <ClockCircleOutlined />{' '}
              {eta === undefined
                ? t('batch.etaMeasuring')
                : t('batch.eta', {left: timeLeft(eta), at: finishesAt(eta, lang)})}
            </Typography.Text>
          ) : null}
          {batch.error ? <Typography.Text type="danger">{batch.error.message}</Typography.Text> : null}
          {batch.status !== 'scheduled' ? (
            <Progress
              percent={finished ? 100 : percent}
              size="small"
              status={batch.status === 'failed' ? 'exception' : finished ? 'success' : 'active'}
            />
          ) : null}
        </Space>
        <Space direction="vertical">
          {preflight.total ? (
            <Button size="small" icon={<UnorderedListOutlined />} onClick={() => setOpen(!open)} aria-expanded={open}>
              {t('batch.items')}
            </Button>
          ) : null}
          {jobs.succeeded > 0 ? (
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              onClick={() => void api().openFolder({batchId: batch.id})}
              data-testid="batch-open-folder"
            >
              {t('batch.openFolder')}
            </Button>
          ) : null}
          {!finished ? (
            <Popconfirm title={t('batch.cancel')} onConfirm={() => void api().cancelBatch(batch.id)}>
              <Button size="small" danger icon={<StopOutlined />}>
                {t('batch.cancel')}
              </Button>
            </Popconfirm>
          ) : null}
        </Space>
      </Flex>
      {open ? <BatchItems batchId={batch.id} /> : null}
    </Card>
  )
})

/** The schedule: running batch on top, then the line, then finished ones newest first. */
export function BatchList() {
  const t = useT()
  const store = useStore()
  const version = store.version
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when the store changes
  const batches = useMemo(() => {
    const order: Record<string, number> = {checking: 0, running: 0, scheduled: 1}
    return [...store.batches.values()].sort(
      (a, b) =>
        (order[a.status] ?? 2) - (order[b.status] ?? 2) ||
        (order[a.status] === 1 ? a.createdAt - b.createdAt : b.createdAt - a.createdAt),
    )
  }, [version])
  if (batches.length === 0) return <Empty description={t('batch.empty')} />
  const finished = batches.reduce((n, batch) => n + (BATCH_FINISHED.has(batch.status) ? 1 : 0), 0)
  const clear = async () => {
    await api().clearFinished()
    store.clearFinished()
  }
  return (
    <Space direction="vertical" className="full">
      <Button icon={<ClearOutlined />} disabled={finished === 0} onClick={() => void clear()}>
        {t('batch.clearFinished', {count: finished})}
      </Button>
      {batches.map(batch => (
        <BatchCard key={batch.id} batch={batch} />
      ))}
    </Space>
  )
}
