import {ReloadOutlined} from '@ant-design/icons'
import {App as AntApp, Button, Empty, Flex, Modal, Select, Table, Tag, Tooltip, Typography} from 'antd'
import type {JobId, JobSnapshot} from 'media-downloader-core'
import {useMemo, useState} from 'react'
import type {FailedRetry} from '../../../shared/contract'
import {api} from '../api'
import {errorText} from '../format'
import {type MessageKey, useT} from '../i18n'
import {failedJobs, useStore} from '../store'

/** Why a job failed, in a few words (its hint, else its error code). */
function CauseTag({job}: {readonly job: JobSnapshot}) {
  const t = useT()
  if (job.error?.hint === 'damaged-source') {
    return (
      <Tooltip title={t('integrity.damagedTip')}>
        <Tag color="error" data-testid="failed-damaged">
          {t('integrity.damaged')}
        </Tag>
      </Tooltip>
    )
  }
  const text = job.error?.hint ? t(`hint.${job.error.hint}` as MessageKey) : job.error?.message
  return (
    <Typography.Text type="danger" className="one-line" title={job.error?.message ?? ''}>
      {text ?? t('failed.unknown')}
    </Typography.Text>
  )
}

/** Damaged at the source: never offered again (it would only fail the same way). */
const retryable = (job: JobSnapshot): boolean => job.error?.hint !== 'damaged-source'

/**
 * This session's failed downloads, from every batch: pick some (or all) and
 * they go into one new batch together, each to the folder it belonged to.
 * The ones damaged at the source are listed but can't be picked.
 */
export function FailedModal({onClose, onCreated}: {readonly onClose: () => void; readonly onCreated: () => void}) {
  const t = useT()
  const {message} = AntApp.useApp()
  const store = useStore()
  const version = store.version
  const [batches, setBatches] = useState<readonly string[]>([])
  const [selected, setSelected] = useState<readonly JobId[]>([])
  const [busy, setBusy] = useState(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when the store changes
  const all = useMemo(() => failedJobs(store).reverse(), [version])
  const rows = batches.length ? all.filter(job => job.batchId && batches.includes(job.batchId)) : all
  const eligible = rows.filter(retryable)
  // a selection follows the list: a job retried elsewhere (or filtered out) leaves it
  const picked = selected.filter(id => eligible.some(job => job.id === id))
  const batchTitle = (job: JobSnapshot) => {
    const batch = job.batchId ? store.batches.get(job.batchId) : undefined
    return batch ? (batch.title ?? batch.url) : undefined
  }
  const batchOptions = useMemo(() => {
    const seen = new Map<string, {value: string; label: string}>()
    for (const job of all) {
      if (!job.batchId || seen.has(job.batchId)) continue
      const batch = store.batches.get(job.batchId)
      const count = all.filter(other => other.batchId === job.batchId).length
      seen.set(job.batchId, {value: job.batchId, label: `${batch?.title ?? batch?.url ?? job.batchId} · ${count}`})
    }
    return [...seen.values()]
  }, [all, store])

  const create = async () => {
    const chosen = all.filter(job => picked.includes(job.id))
    if (chosen.length === 0) return
    setBusy(true)
    try {
      const items: FailedRetry[] = chosen.map(job => ({
        jobId: job.id,
        url: job.url,
        title: job.title,
        mediaId: job.mediaId,
        profile: job.profile,
      }))
      const batch = await api().retryFailed(items)
      store.apply({batches: [batch], jobs: [], items: [], logs: []})
      store.markRetried(chosen.map(job => job.id))
      void message.success(t('failed.created', {count: chosen.length}))
      setSelected([])
      onCreated()
    } catch (error) {
      void message.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      title={t('failed.title', {count: all.length})}
      onCancel={onClose}
      width={880}
      footer={[
        <Button key="close" onClick={onClose}>
          {t('common.close')}
        </Button>,
        <Button
          key="retry"
          type="primary"
          icon={<ReloadOutlined />}
          disabled={picked.length === 0}
          loading={busy}
          onClick={() => void create()}
          data-testid="failed-retry"
        >
          {t('failed.retry', {count: picked.length})}
        </Button>,
      ]}
    >
      <Flex vertical gap={8} data-testid="failed-modal">
        <Typography.Text type="secondary">{t('failed.hint')}</Typography.Text>
        {all.length > 0 ? (
          <Flex gap={8} wrap align="center">
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={t('filter.allBatches')}
              aria-label={t('failed.batches')}
              value={[...batches]}
              options={batchOptions}
              onChange={next => setBatches(next)}
              style={{minWidth: 320, flex: 1}}
              maxTagCount="responsive"
              data-testid="failed-batches"
            />
            <Button onClick={() => setSelected(eligible.map(job => job.id))} disabled={eligible.length === 0}>
              {t('failed.selectAll', {count: eligible.length})}
            </Button>
          </Flex>
        ) : null}
        <Table<JobSnapshot>
          size="small"
          rowKey="id"
          dataSource={rows}
          pagination={rows.length > 50 ? {pageSize: 50, showSizeChanger: false} : false}
          scroll={{y: 380, x: 760}}
          locale={{emptyText: <Empty description={t('failed.empty')} />}}
          rowSelection={{
            selectedRowKeys: [...picked],
            preserveSelectedRowKeys: true,
            onChange: keys => setSelected(keys.map(key => String(key) as JobId)),
            getCheckboxProps: job => ({disabled: !retryable(job), 'aria-label': job.title ?? job.url}),
          }}
          columns={[
            {
              title: t('job.title'),
              key: 'title',
              ellipsis: true,
              render: (_, job) => (
                <Flex vertical>
                  <Typography.Text className="one-line" title={job.title ?? job.url}>
                    {job.title ?? job.url}
                  </Typography.Text>
                  <Typography.Text type="secondary" className="one-line mono" title={job.url}>
                    {job.url}
                  </Typography.Text>
                </Flex>
              ),
            },
            {
              title: t('failed.batch'),
              key: 'batch',
              width: 200,
              ellipsis: true,
              render: (_, job) => (
                <Typography.Text type="secondary" className="one-line" title={batchTitle(job) ?? ''}>
                  {batchTitle(job) ?? '—'}
                </Typography.Text>
              ),
            },
            {title: t('failed.cause'), key: 'cause', width: 220, render: (_, job) => <CauseTag job={job} />},
          ]}
        />
      </Flex>
    </Modal>
  )
}
