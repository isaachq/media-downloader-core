import {
  ClearOutlined,
  ClockCircleOutlined,
  DatabaseOutlined,
  FolderOpenOutlined,
  RedoOutlined,
  SafetyCertificateOutlined,
  StopOutlined,
  UnorderedListOutlined,
} from '@ant-design/icons'
import {
  App as AntApp,
  Button,
  Card,
  Empty,
  Flex,
  Popconfirm,
  Progress,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type {BatchId, BatchSnapshot, JobId, PreflightItem} from 'media-downloader-core'
import {memo, useCallback, useEffect, useMemo, useState} from 'react'
import {api} from '../api'
import {useApp} from '../context'
import {bytes, clock, finishesAt, timeLeft} from '../format'
import {type MessageKey, useT} from '../i18n'
import {BATCH_FINISHED, useAppStore, useStore, useStoreValue} from '../store'
import {useShowBatch} from './BatchFilter'
import {Problems} from './Problems'

const STATUS_COLOR: Readonly<Record<BatchSnapshot['status'], string>> = {
  scheduled: 'default',
  checking: 'processing',
  running: 'processing',
  validating: 'processing',
  completed: 'success',
  'completed-with-errors': 'warning',
  failed: 'error',
  cancelled: 'warning',
}
const PAGE = 50

/**
 * The download of one item, while it runs: Cancel drops only this item —
 * the batch goes on with the rest. Re-renders when that job's status changes.
 */
function ItemCancel({jobId}: {readonly jobId: JobId}) {
  const t = useT()
  const outcome = useStoreValue(store => store.jobs.get(jobId)?.outcome)
  const status = useStoreValue(store => store.jobs.get(jobId)?.status)
  if (status === 'cancelled') return <Tag color="warning">{t('job.status.cancelled')}</Tag>
  if (outcome !== 'in-progress') return null
  return (
    <Tooltip title={t('job.cancelOne')}>
      <Button
        size="small"
        icon={<StopOutlined />}
        aria-label={t('job.cancelOne')}
        onClick={() => void api().cancelJob(jobId)}
        data-testid="item-cancel"
      />
    </Tooltip>
  )
}

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
      store.onItem(batchId, item =>
        setRows(current => {
          // an item off the page shown changes nothing: same array, no render — O(1) instead of O(page)
          const at = current.findIndex(row => row.index === item.index)
          if (at < 0) return current
          const next = current.slice()
          next[at] = item
          return next
        }),
      ),
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
        {
          title: <ClockCircleOutlined aria-label="Duration" />,
          key: 'duration',
          width: 80,
          render: (_, item) => clock(item.duration),
        },
        {
          title: <DatabaseOutlined aria-label="Size" />,
          key: 'size',
          width: 100,
          render: (_, item) => bytes(item.estimatedBytes, settings.language),
        },
        {
          title: t('job.status'),
          key: 'state',
          width: 300,
          render: (_, item) => (
            <Space size={4} wrap>
              {item.error?.hint === 'damaged-source' ? (
                <Tooltip title={`${t('integrity.damagedTip')} ${item.error.message}`}>
                  <Tag color="error" data-testid="item-damaged">
                    {t('integrity.damaged')}
                  </Tag>
                </Tooltip>
              ) : (
                <Tag color={item.state === 'ok' ? 'success' : item.state === 'unavailable' ? 'error' : 'processing'}>
                  {t(`item.state.${item.state}` as MessageKey)}
                </Tag>
              )}
              {item.archived ? <Tag color="cyan">{t('item.archived')}</Tag> : null}
              {item.tier && item.tier !== 'normal' ? (
                <Tag color="gold">{t(`job.tier.${item.tier}` as MessageKey)}</Tag>
              ) : null}
              {item.jobId ? <ItemCancel jobId={item.jobId} /> : null}
              {item.error && item.error.hint !== 'damaged-source' ? (
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
  const {message} = AntApp.useApp()
  const showBatch = useShowBatch()
  const {settings} = useApp()
  const [open, setOpen] = useState(false)
  const lang = settings.language
  const {preflight, jobs, estimate} = batch
  const cancelled = jobs.cancelled ?? 0
  // damaged at the source: listed among the failures, never offered again
  const retryable = jobs.failed - (batch.problems?.failed['damaged-source'] ?? 0)
  const done = jobs.succeeded + jobs.failed + cancelled
  const finished = ['completed', 'completed-with-errors', 'failed', 'cancelled'].includes(batch.status)
  const checkingFiles = batch.status === 'validating' ? batch.validation : undefined
  const percent =
    batch.status === 'checking'
      ? Math.round((preflight.checked / Math.max(1, preflight.total)) * 100)
      : checkingFiles
        ? Math.floor((checkingFiles.done / Math.max(1, checkingFiles.total)) * 100)
        : batch.progress
          ? Math.floor(batch.progress.fraction * 100) // weighted by size, includes running downloads
          : Math.round((done / Math.max(1, jobs.total)) * 100)
  const eta = batch.status === 'running' ? batch.progress?.etaSeconds : undefined

  return (
    <Card size="small" className="batch-card" data-testid="batch-card" data-status={batch.status}>
      <Flex justify="space-between" align="start" gap={12}>
        <Space orientation="vertical" size={2} className="full">
          <Space wrap>
            <Tag color={STATUS_COLOR[batch.status]} data-testid="batch-status">
              {t(`batch.status.${batch.status}` as MessageKey)}
            </Tag>
            {batch.mix ? (
              <Tag color="purple" data-testid="batch-mix">
                {t('batch.mix')}
              </Tag>
            ) : batch.kind ? (
              <Tag>{t(batch.kind === 'playlist' ? 'batch.playlist' : 'batch.video')}</Tag>
            ) : null}
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
              {estimate.bytes > 0 || estimate.unknown === 0
                ? t('batch.forecast', {
                    bytes: bytes(estimate.bytes, lang),
                    required: bytes(estimate.requiredBytes, lang),
                    free: bytes(estimate.freeBytes, lang),
                  })
                : // the site gave no sizes: no made-up figures, only the free space
                  t('batch.forecastUnknown', {free: bytes(estimate.freeBytes, lang)})}
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
              {cancelled ? ` · ${t('batch.cancelledCount', {count: cancelled})}` : ''}
            </Typography.Text>
          ) : null}
          {batch.status === 'validating' ? (
            <Typography.Text data-testid="batch-validating">
              <SafetyCertificateOutlined />{' '}
              {t('batch.validating', {done: checkingFiles?.done ?? 0, total: checkingFiles?.total ?? 0})}
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
          <Problems problems={batch.problems} />
          {batch.status !== 'scheduled' ? (
            <Progress
              percent={finished ? 100 : percent}
              size="small"
              status={batch.status === 'failed' ? 'exception' : finished ? 'success' : 'active'}
            />
          ) : null}
        </Space>
        <Space orientation="vertical">
          {preflight.total ? (
            <Button size="small" icon={<UnorderedListOutlined />} onClick={() => setOpen(!open)} aria-expanded={open}>
              {t('batch.items')}
            </Button>
          ) : null}
          {jobs.total > 0 ? (
            <Space.Compact size="small">
              <Button size="small" onClick={() => showBatch('jobs', batch.id)} data-testid="batch-show-jobs">
                {t('tabs.jobs')}
              </Button>
              {jobs.succeeded > 0 ? (
                <Button
                  size="small"
                  type={finished ? 'primary' : 'default'}
                  onClick={() => showBatch('finished', batch.id)}
                  data-testid="batch-show-finished"
                >
                  {t('tabs.finished')}
                </Button>
              ) : null}
            </Space.Compact>
          ) : null}
          {retryable > 0 && (finished || batch.status === 'running') ? (
            <Button
              size="small"
              icon={<RedoOutlined />}
              onClick={() =>
                void api()
                  .retryBatch(batch.id)
                  .then(count => message.info(t('batch.retried', {count})))
              }
              data-testid="batch-retry-failed"
            >
              {t('batch.retryFailed', {count: retryable})}
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
            <Popconfirm
              title={t('batch.cancel')}
              description={t('batch.cancelWhole')}
              onConfirm={() => void api().cancelBatch(batch.id)}
            >
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
    <Space orientation="vertical" className="full">
      <Button icon={<ClearOutlined />} disabled={finished === 0} onClick={() => void clear()}>
        {t('batch.clearFinished', {count: finished})}
      </Button>
      {batches.map(batch => (
        <BatchCard key={batch.id} batch={batch} />
      ))}
    </Space>
  )
}
