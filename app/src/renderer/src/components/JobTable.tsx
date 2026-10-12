import {
  FolderOpenOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RedoOutlined,
  StopOutlined,
} from '@ant-design/icons'
import {Button, Empty, Progress, Space, Table, Tag, Tooltip, Typography} from 'antd'
import type {ColumnsType} from 'antd/es/table'
import type {JobSnapshot} from 'media-downloader-core'
import {useMemo, useState} from 'react'
import {api} from '../api'
import {useApp} from '../context'
import {clock, rate} from '../format'
import {type MessageKey, useT} from '../i18n'
import {useStore} from '../store'
import {BatchFilter} from './BatchFilter'
import {IntegrityTag, StatusTag, StepTrack} from './JobParts'

const TIER_COLOR = {normal: 'default', long: 'gold', heavy: 'volcano'} as const

/** Running first (the live threads), then queued, then finished newest first. */
function rank(job: JobSnapshot): number {
  if (job.outcome !== 'in-progress') return 2
  return job.status === 'queued' ? 1 : 0
}

/**
 * One row per download thread. Virtualized: thousands of rows render only
 * what's on screen; rows come from the store, updated ≤ 10×/s.
 */
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when the store changes
  const rows = useMemo(() => {
    const list = batchId ? [...store.jobs.values()].filter(job => job.batchId === batchId) : [...store.jobs.values()]
    return list
      .map((job, order) => ({job, order}))
      .sort((a, b) => rank(a.job) - rank(b.job) || (rank(a.job) === 2 ? b.order - a.order : a.order - b.order))
      .map(({job}) => job)
  }, [version, batchId])

  const columns: ColumnsType<JobSnapshot> = [
    {
      title: t('job.title'),
      key: 'title',
      ellipsis: true,
      render: (_, job) => (
        <Space direction="vertical" size={0} className="job-title">
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
        const fraction = job.progress.fraction
        const percent = job.outcome === 'success' ? 100 : fraction === undefined ? 0 : Math.round(fraction * 100)
        const status = job.outcome === 'failed' ? 'exception' : job.outcome === 'success' ? 'success' : 'active'
        return (
          <Space direction="vertical" size={0} className="job-progress">
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
            ) : job.error ? (
              <Typography.Text type="danger" className="one-line" title={job.error.message}>
                {job.error.hint ? t(`hint.${job.error.hint}` as MessageKey) : job.error.message}
              </Typography.Text>
            ) : null}
          </Space>
        )
      },
    },
    {title: t('job.steps'), key: 'steps', width: 150, render: (_, job) => <StepTrack steps={job.steps} />},
    {title: t('job.integrity'), key: 'integrity', width: 130, render: (_, job) => <IntegrityTag job={job} />},
    {
      title: t('job.actions'),
      key: 'actions',
      width: 120,
      render: (_, job) => (
        <Space size={4}>
          {job.outcome === 'in-progress' ? (
            <Tooltip title={t('job.cancel')}>
              <Button
                size="small"
                icon={<StopOutlined />}
                aria-label={t('job.cancel')}
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

  const togglePause = async () => {
    if (paused) await api().resume()
    else await api().pause()
    setPaused(!paused)
  }

  return (
    <Space direction="vertical" className="full">
      <Space wrap>
        {onBatch ? <BatchFilter value={batchId} options={options} onChange={onBatch} /> : null}
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
      <Table<JobSnapshot>
        size="small"
        rowKey="id"
        columns={columns}
        dataSource={rows}
        pagination={false}
        virtual={rows.length > 100}
        scroll={{y: 420, x: 960}}
        locale={{emptyText: <Empty description={t('job.empty')} />}}
        rowClassName={job => `job-row job-${job.outcome}`}
      />
    </Space>
  )
}
