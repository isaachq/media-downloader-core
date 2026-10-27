import {
  FolderOpenOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  StopOutlined,
} from '@ant-design/icons'
import {Alert, Button, Empty, Progress, Segmented, Space, Table, Tag, Tooltip, Typography} from 'antd'
import type {ColumnsType} from 'antd/es/table'
import type {JobSnapshot} from 'media-downloader-core'
import {useMemo, useState} from 'react'
import {api} from '../api'
import {useApp} from '../context'
import {clock, rate} from '../format'
import {type MessageKey, useT} from '../i18n'
import {useStore, WORKING} from '../store'
import {BatchFilter, useShowBatch} from './BatchFilter'
import {IntegrityTag, StatusTag, StepTrack} from './JobParts'

const TIER_COLOR = {normal: 'default', long: 'gold', heavy: 'volcano'} as const

/** Running first (the live threads), then queued, then finished newest first. */
function rank(job: JobSnapshot): 0 | 1 | 2 {
  if (job.outcome !== 'in-progress') return 2
  return job.status === 'queued' ? 1 : 0
}

/**
 * One row per download thread. Virtualized: thousands of rows render only
 * what's on screen; rows come from the store, updated ≤ 10×/s.
 */
type StatusFilter = 'all' | 'working' | 'queued' | 'completed' | 'failed'

/** The filter bucket a job falls in; cancelled jobs are in none (only "all" shows them). */
const bucketOf = (job: JobSnapshot): Exclude<StatusFilter, 'all'> | undefined => {
  if (WORKING.has(job.status)) return 'working'
  if (job.status === 'queued') return 'queued'
  if (job.status === 'completed' || job.status === 'skipped') return 'completed'
  if (job.status === 'failed') return 'failed'
  return undefined
}

export function JobTable({
  batchId,
  onBatch,
}: {
  readonly batchId?: string | undefined
  readonly onBatch?: ((batchId: string | undefined) => void) | undefined
} = {}) {
  const t = useT()
  const {settings} = useApp()
  const store = useStore()
  const version = store.version
  const [paused, setPaused] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when the store changes
  const options = useMemo(
    () =>
      [...store.batches.values()]
        .filter(batch => batch.jobs.total > 0)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(batch => ({
          value: batch.id,
          label: `${batch.title ?? batch.url} · ${t(`batch.status.${batch.status}` as MessageKey)}`,
        })),
    [version, t],
  )

  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  // one pass over the jobs per store change: the rows of this batch, their counts per filter
  // and the rows the filter keeps — O(jobs), not three times that
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when the store changes
  const {total, counts, filteredRows} = useMemo(() => {
    const counts = {working: 0, queued: 0, completed: 0, failed: 0}
    // working first, then queued (both in arrival order), then finished newest first: three
    // buckets filled in arrival order give that order with no sort — O(jobs), not O(jobs log jobs)
    const byRank: [JobSnapshot[], JobSnapshot[], JobSnapshot[]] = [[], [], []]
    let order = 0
    for (const job of store.jobs.values()) {
      if (batchId && job.batchId !== batchId) continue
      const bucket = bucketOf(job)
      if (bucket) counts[bucket]++
      if (statusFilter === 'all' || bucket === statusFilter) byRank[rank(job)]!.push(job)
      order++
    }
    const [working, queued, finished] = byRank
    return {total: order, counts, filteredRows: working.concat(queued, finished.reverse())}
  }, [version, batchId, statusFilter])

  const columns: ColumnsType<JobSnapshot> = [
    {
      title: t('job.title'),
      key: 'title',
      ellipsis: true,
      render: (_, job) => (
        <Space orientation="vertical" size={0} className="job-title">
          <Typography.Text className="one-line" title={job.title ?? job.url}>
            {job.title ?? job.url}
          </Typography.Text>
          <Space size={4}>
            <Typography.Text type="secondary" className="mono">
              {job.id.slice(0, 8)}
            </Typography.Text>
            {job.tier !== 'normal' ? (
              <Tag color={TIER_COLOR[job.tier]}>{t(`job.tier.${job.tier}` as MessageKey)}</Tag>
            ) : null}
            {job.attempt > 1 ? (
              <Tag color="warning">{t('job.attempt', {attempt: job.attempt, max: job.maxAttempts})}</Tag>
            ) : null}
          </Space>
        </Space>
      ),
    },
    {title: t('job.status'), key: 'status', width: 150, render: (_, job) => <StatusTag job={job} />},
    {
      title: t('job.progress'),
      key: 'progress',
      width: 230,
      render: (_, job) => {
        // a live recording has no end to measure: REC and how long it has recorded, no bar
        if (job.progress.live && job.status === 'downloading')
          return (
            <Space size={4} className="job-progress" data-testid="job-live">
              <Tag color="red">● {t('live.rec')}</Tag>
              <Typography.Text className="mono">
                {clock(job.progress.elapsedSec) || '0:00'} · {rate(job.progress.speed, settings.language)}
              </Typography.Text>
            </Space>
          )
        const fraction = job.progress.fraction
        const percent = job.outcome === 'success' ? 100 : fraction === undefined ? 0 : Math.round(fraction * 100)
        const status = job.outcome === 'failed' ? 'exception' : job.outcome === 'success' ? 'success' : 'active'
        return (
          <Space orientation="vertical" size={0} className="job-progress">
            <Progress
              percent={percent}
              size="small"
              status={status}
              showInfo={fraction !== undefined || job.outcome !== 'in-progress'}
              className="full"
            />
            {job.status === 'downloading' ? (
              <Typography.Text type="secondary" className="mono">
                {rate(job.progress.speed, settings.language)} {job.progress.eta ? `· ${clock(job.progress.eta)}` : ''}
              </Typography.Text>
            ) : job.error && job.status !== 'cancelled' ? (
              <Typography.Text type="danger" className="one-line" title={job.error.message}>
                {job.error.hint ? t(`hint.${job.error.hint}` as MessageKey) : job.error.message}
              </Typography.Text>
            ) : null}
          </Space>
        )
      },
    },
    {title: t('job.steps'), key: 'steps', width: 150, render: (_, job) => <StepTrack steps={job.steps} />},
    {title: t('job.integrity'), key: 'integrity', width: 150, render: (_, job) => <IntegrityTag job={job} />},
    {
      title: t('job.actions'),
      key: 'actions',
      width: 120,
      render: (_, job) => (
        <Space size={4}>
          {job.outcome === 'in-progress' ? (
            <Tooltip title={job.batchId ? t('job.cancelOne') : t('job.cancel')}>
              <Button
                size="small"
                icon={<StopOutlined />}
                aria-label={job.batchId ? t('job.cancelOne') : t('job.cancel')}
                onClick={() => void api().cancelJob(job.id)}
              />
            </Tooltip>
          ) : null}
          {job.status === 'failed' || job.status === 'cancelled' ? (
            <Tooltip title={t('job.retry')}>
              <Button
                size="small"
                icon={<RedoOutlined />}
                aria-label={t('job.retry')}
                onClick={() => void api().retryJob(job.id)}
              />
            </Tooltip>
          ) : null}
          {job.filepath ? (
            <Tooltip title={t('job.reveal')}>
              <Button
                size="small"
                icon={<FolderOpenOutlined />}
                aria-label={t('job.reveal')}
                onClick={() => void api().reveal(job.filepath!)}
              />
            </Tooltip>
          ) : null}
        </Space>
      ),
    },
  ]

  const showBatch = useShowBatch()

  const togglePause = async () => {
    if (paused) await api().resume()
    else await api().pause()
    setPaused(!paused)
  }

  return (
    <Space orientation="vertical" className="full">
      <Space wrap align="center">
        {onBatch ? <BatchFilter value={batchId} options={options} onChange={onBatch} /> : null}
        <Segmented
          size="small"
          value={statusFilter}
          onChange={val => setStatusFilter(val as typeof statusFilter)}
          options={[
            {label: t('job.filter.all', {count: total}), value: 'all'},
            {label: t('job.filter.working', {count: counts.working}), value: 'working'},
            {label: t('job.filter.queued', {count: counts.queued}), value: 'queued'},
            {label: t('job.filter.completed', {count: counts.completed}), value: 'completed'},
            {label: t('job.filter.failed', {count: counts.failed}), value: 'failed'},
          ]}
        />
        <Button icon={paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />} onClick={() => void togglePause()}>
          {paused ? t('job.resume') : t('job.pause')}
        </Button>
        <Button
          onClick={async () => {
            await api().clearFinished()
            store.clearFinished()
          }}
        >
          {t('job.clearFinished')}
        </Button>
      </Space>
      {total > 0 && counts.working === 0 && counts.queued === 0 && counts.completed > 0 ? (
        <Alert
          type="success"
          showIcon
          title={
            batchId
              ? `${t('batch.status.completed')} (${counts.completed})`
              : `${t('batch.status.completed')}: ${counts.completed} ${t('tabs.finished').toLowerCase()}`
          }
          action={
            <Button size="small" type="primary" onClick={() => showBatch('finished', batchId ?? '')}>
              {t('tabs.finished')}
            </Button>
          }
        />
      ) : null}
      <Table<JobSnapshot>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={filteredRows}
        pagination={false}
        virtual={filteredRows.length > 100}
        scroll={{y: 420, x: 960}}
        locale={{emptyText: <Empty description={t('job.empty')} />}}
        rowClassName={job => `job-row job-${job.outcome}`}
      />
    </Space>
  )
}
