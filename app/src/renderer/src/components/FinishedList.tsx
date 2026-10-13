import {
  ClearOutlined,
  CloseCircleFilled,
  CopyOutlined,
  DeleteOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import {App as AntApp, Button, Empty, Flex, Input, Popconfirm, Space, Table, Tag, Tooltip, Typography} from 'antd'
import {useCallback, useEffect, useRef, useState} from 'react'
import {
  FINISHED_INTEGRITY,
  type FinishedEntry,
  type FinishedGroup,
  type FinishedIntegrity,
  type FinishedPage,
  type FinishedSort,
  type FinishedTarget,
  SIZE_RANGES,
  type SizeRange,
} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {bytes, clock, moment} from '../format'
import {type MessageKey, useT} from '../i18n'
import {useStoreValue} from '../store'
import {BatchFilter} from './BatchFilter'

const PAGE = 50
/** A finished download refreshes the page shown at most this often. */
const LIVE_MS = 2000
const SEARCH_MS = 250

/** A finished file: verified (a check ran), not checked (checksum only), checksum (older record), or gone / changed on disk. */
function FileTag({entry}: {readonly entry: FinishedEntry}) {
  const t = useT()
  // damaged at the source: kept, never downloaded again — why, on hover
  if (entry.damaged) {
    return (
      <Tooltip title={`${t('integrity.damagedTip')} ${entry.damaged}`}>
        <Tag color="error" icon={<CloseCircleFilled />} data-testid="finished-damaged">
          {t('integrity.damaged')}
        </Tag>
      </Tooltip>
    )
  }
  if (entry.file === 'missing') return <Tag color="error">{t('finished.missing')}</Tag>
  if (entry.file === 'changed') return <Tag color="warning">{t('finished.changed')}</Tag>
  const hash = entry.sha256 ? t('finished.hashTip', {hash: entry.sha256.slice(0, 16)}) : undefined
  // only a check that ran is "verified": with the check off, the file only has its checksum
  if (entry.validation === 'quick' || entry.validation === 'full') {
    return (
      <Tooltip title={[t(`finished.check.${entry.validation}` as MessageKey), hash].filter(Boolean).join(' · ')}>
        <Tag color="success" icon={<SafetyCertificateOutlined />}>
          {t('finished.verified')}
        </Tag>
      </Tooltip>
    )
  }
  if (entry.validation === 'none' || !entry.sha256) {
    return (
      <Tooltip title={hash}>
        <Tag>{t('finished.unverified')}</Tag>
      </Tooltip>
    )
  }
  return (
    <Tooltip title={hash}>
      <Tag color="cyan">{t('finished.checksum')}</Tag>
    </Tooltip>
  )
}

/**
 * Every finished download, from every session (the engine's archive), newest
 * first: search, play, show in folder, copy the path. Pages come from the
 * main process 50 at a time; the page shown follows new completions (at most
 * every 2 s) without re-rendering on every progress event.
 */
export function FinishedList({
  batchId,
  onBatch,
}: {
  readonly batchId?: string | undefined
  readonly onBatch?: ((batchId: string | undefined) => void) | undefined
} = {}) {
  const t = useT()
  const {settings} = useApp()
  const {message, modal} = AntApp.useApp()
  const lang = settings.language
  // only the number of finished jobs: one re-render per completion, not per event
  const finishedNow = useStoreValue(store => store.counts.completed + store.counts.skipped)
  const [page, setPage] = useState(1)
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [data, setData] = useState<FinishedPage | undefined>()
  const [loading, setLoading] = useState(true)
  const [groups, setGroups] = useState<readonly FinishedGroup[]>([])
  const [selected, setSelected] = useState<readonly string[]>([])
  const [checking, setChecking] = useState<{done: number; total: number} | undefined>()
  // the header filters (Integrity, Size) and the sort (Finished, Size), applied by the main process
  const [integrity, setIntegrity] = useState<readonly FinishedIntegrity[]>([])
  const [size, setSize] = useState<readonly SizeRange[]>([])
  const [sort, setSort] = useState<FinishedSort>('newest')
  const [pruning, setPruning] = useState(false)
  const latest = useRef(0)

  const load = useCallback(
    async (quiet = false) => {
      const request = ++latest.current
      if (!quiet) setLoading(true)
      try {
        const [result, batches] = await Promise.all([
          api().finished({
            offset: (page - 1) * PAGE,
            limit: PAGE,
            search: search || undefined,
            batchId,
            ...(integrity.length > 0 && {integrity}),
            ...(size.length > 0 && {size}),
            sort,
          }),
          api().finishedGroups(),
        ])
        // an answer to an older request (another page, another search) is dropped
        if (request === latest.current) {
          setData(result)
          setGroups(batches)
        }
      } finally {
        if (request === latest.current) setLoading(false)
      }
    },
    [page, search, batchId, integrity, size, sort],
  )
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(typed.trim())
      setPage(1)
    }, SEARCH_MS)
    return () => clearTimeout(timer)
  }, [typed])

  // live: throttled, so a burst of completions costs one request
  const pending = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const first = useRef(true)
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the number of finished jobs changes
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (pending.current) return
    pending.current = setTimeout(() => {
      pending.current = undefined
      void loadRef.current(true)
    }, LIVE_MS)
  }, [finishedNow])
  useEffect(() => () => clearTimeout(pending.current), [])
  // a new filter starts from its first page, nothing selected
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when the batch changes
  useEffect(() => {
    setPage(1)
    setSelected([])
  }, [batchId])
  useEffect(() => api().onVerifyProgress(setChecking), [])

  /** What the filters show (words, batch, header filters). */
  const shown = () => ({
    all: true as const,
    search: search || undefined,
    batchId,
    ...(integrity.length > 0 && {integrity}),
    ...(size.length > 0 && {size}),
  })
  /** The rows picked, else everything the filter shows. */
  const scope = (): FinishedTarget => (selected.length > 0 ? {keys: selected} : shown())
  const filtered = integrity.length > 0 || size.length > 0

  const verify = async () => {
    setChecking({done: 0, total: selected.length || data?.total || 0})
    try {
      const summary = await api().verifyFinished(scope())
      const text = t('finished.verifyResult', {...summary})
      if (summary.missing + summary.changed + summary.corrupted > 0)
        modal.warning({title: t('finished.verify'), content: text})
      else void message.success(text)
      void load(true)
    } finally {
      setChecking(undefined)
    }
  }
  const remove = async () => {
    const count = await api().removeFinished(selected)
    setSelected([])
    void message.success(t('finished.removed', {count}))
    void load(true)
  }
  const prune = async () => {
    setPruning(true)
    try {
      const count = await api().pruneFinished(scope())
      setSelected([])
      void message.success(count ? t('finished.pruned', {count}) : t('finished.prunedNone'))
      void load(true)
    } finally {
      setPruning(false)
    }
  }
  const exportCsv = async () => {
    const file = await api().exportFinished(shown())
    if (file) void message.success(t('finished.exported', {file}))
  }

  const open = async (entry: FinishedEntry, target: 'file' | 'folder') => {
    if (!(await api().openFinished(entry.key, target))) {
      void message.warning(t('finished.gone'))
      void load(true)
    }
  }
  const copy = async (entry: FinishedEntry) => {
    await navigator.clipboard?.writeText(entry.filepath)
    void message.success(t('common.copied'))
  }

  const empty = data && data.total === 0
  return (
    <Space orientation="vertical" className="full" data-testid="finished-list">
      <Flex gap={8} wrap align="center">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          aria-label={t('finished.search')}
          placeholder={t('finished.search')}
          value={typed}
          onChange={event => setTyped(event.target.value)}
          style={{flex: 1, minWidth: 240}}
        />
        {onBatch ? (
          <BatchFilter
            value={batchId}
            onChange={onBatch}
            options={groups.map(group => ({
              value: group.batchId,
              label: `${group.title ?? group.batchId} · ${group.count}`,
            }))}
          />
        ) : null}
        <Button icon={<FolderOpenOutlined />} onClick={() => void api().openFolder('downloads')}>
          {t('finished.openDownloads')}
        </Button>
      </Flex>
      <Flex gap={8} wrap align="center">
        <Button
          icon={<SafetyCertificateOutlined />}
          loading={checking !== undefined}
          disabled={!data?.total}
          onClick={() => void verify()}
          data-testid="finished-verify"
        >
          {selected.length ? t('finished.verifySelected', {count: selected.length}) : t('finished.verify')}
        </Button>
        <Button icon={<ExportOutlined />} disabled={!data?.total} onClick={() => void exportCsv()}>
          {t('finished.export')}
        </Button>
        <Popconfirm
          title={t('finished.prune')}
          description={t('finished.pruneConfirm')}
          onConfirm={() => void prune()}
          okText={t('finished.pruneOk')}
        >
          <Button icon={<ClearOutlined />} loading={pruning} disabled={!data?.total} data-testid="finished-prune">
            {selected.length ? t('finished.pruneSelected', {count: selected.length}) : t('finished.prune')}
          </Button>
        </Popconfirm>
        {selected.length ? (
          <Popconfirm title={t('finished.removeConfirm')} onConfirm={() => void remove()}>
            <Button danger icon={<DeleteOutlined />} data-testid="finished-remove">
              {t('finished.remove', {count: selected.length})}
            </Button>
          </Popconfirm>
        ) : null}
        {checking ? (
          <Typography.Text type="secondary" data-testid="finished-checking">
            {t('finished.verifying', {done: checking.done, total: checking.total})}
          </Typography.Text>
        ) : null}
      </Flex>
      {data && data.total > 0 ? (
        <Typography.Text type="secondary" data-testid="finished-summary">
          {t(data.total === 1 ? 'finished.summaryOne' : 'finished.summary', {
            count: data.total,
            bytes: bytes(data.bytes, lang),
          })}{' '}
          · {t('finished.live')}
        </Typography.Text>
      ) : null}
      <Table<FinishedEntry>
        size="small"
        rowKey="key"
        loading={loading}
        dataSource={data ? [...data.entries] : []}
        pagination={
          data && data.total > PAGE
            ? {current: page, pageSize: PAGE, total: data.total, onChange: setPage, showSizeChanger: false}
            : false
        }
        scroll={{y: 420, x: 960}}
        locale={{
          emptyText: (
            <Empty description={empty && (search || filtered) ? t('finished.noMatch') : t('finished.empty')} />
          ),
        }}
        rowClassName={entry => (entry.file === 'ok' ? 'finished-row' : 'finished-row finished-gone')}
        rowSelection={{
          selectedRowKeys: [...selected],
          preserveSelectedRowKeys: true,
          onChange: keys => setSelected(keys.map(String)),
        }}
        onChange={(_pagination, filters, sorter, extra) => {
          if (extra.action === 'paginate') return
          const one = Array.isArray(sorter) ? sorter[0] : sorter
          const next: FinishedSort =
            one?.columnKey === 'size' && one.order
              ? one.order === 'ascend'
                ? 'smallest'
                : 'largest'
              : one?.columnKey === 'at' && one.order === 'ascend'
                ? 'oldest'
                : 'newest'
          setIntegrity((filters['integrity'] ?? []).map(String) as FinishedIntegrity[])
          setSize((filters['size'] ?? []).map(String) as SizeRange[])
          setSort(next)
          setPage(1)
          setSelected([])
        }}
        columns={[
          {
            title: t('job.title'),
            key: 'title',
            ellipsis: true,
            render: (_, entry) => (
              <Space orientation="vertical" size={0} className="job-title">
                <Typography.Text className="one-line" title={entry.title}>
                  {entry.title}
                </Typography.Text>
                <Typography.Text type="secondary" className="one-line mono" title={entry.filepath}>
                  {[entry.extractor, entry.filepath.split(/[\\/]/).at(-1), batchId ? undefined : entry.batchTitle]
                    .filter(Boolean)
                    .join(' · ')}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: t('finished.col.finishedAt'),
            key: 'at',
            width: 170,
            sorter: true,
            sortDirections: ['descend', 'ascend'],
            sortOrder: sort === 'newest' ? 'descend' : sort === 'oldest' ? 'ascend' : null,
            render: (_, entry) => moment(entry.completedAt, lang),
          },
          {title: '⏱', key: 'length', width: 80, align: 'right', render: (_, entry) => clock(entry.duration)},
          {
            title: t('finished.col.size'),
            key: 'size',
            width: 130,
            align: 'right',
            sorter: true,
            sortDirections: ['descend', 'ascend'],
            sortOrder: sort === 'largest' ? 'descend' : sort === 'smallest' ? 'ascend' : null,
            filters: SIZE_RANGES.map(range => ({text: t(`finished.size.${range}` as MessageKey), value: range})),
            filteredValue: [...size],
            render: (_, entry) => bytes(entry.sizeBytes, lang),
          },
          {
            title: t('job.integrity'),
            key: 'integrity',
            width: 170,
            filters: FINISHED_INTEGRITY.map(state => ({
              text: t(`finished.integrity.${state}` as MessageKey),
              value: state,
            })),
            filteredValue: [...integrity],
            render: (_, entry) => <FileTag entry={entry} />,
          },
          {
            title: t('job.actions'),
            key: 'actions',
            width: 120,
            render: (_, entry) => (
              <Space size={4}>
                <Tooltip title={t('finished.open')}>
                  <Button
                    size="small"
                    icon={<PlayCircleOutlined />}
                    aria-label={t('finished.open')}
                    disabled={entry.file === 'missing'}
                    onClick={() => void open(entry, 'file')}
                  />
                </Tooltip>
                <Tooltip title={t('finished.reveal')}>
                  <Button
                    size="small"
                    icon={<FolderOpenOutlined />}
                    aria-label={t('finished.reveal')}
                    disabled={entry.file === 'missing'}
                    onClick={() => void open(entry, 'folder')}
                  />
                </Tooltip>
                <Tooltip title={t('finished.copyPath')}>
                  <Button
                    size="small"
                    icon={<CopyOutlined />}
                    aria-label={t('finished.copyPath')}
                    onClick={() => void copy(entry)}
                  />
                </Tooltip>
              </Space>
            ),
          },
        ]}
      />
    </Space>
  )
}
