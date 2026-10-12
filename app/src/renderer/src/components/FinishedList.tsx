import {
  CopyOutlined,
  FolderOpenOutlined,
  PlayCircleOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
} from '@ant-design/icons'
import {App as AntApp, Button, Empty, Flex, Input, Space, Table, Tag, Tooltip, Typography} from 'antd'
import {useCallback, useEffect, useRef, useState} from 'react'
import type {FinishedEntry, FinishedPage} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {bytes, clock, moment} from '../format'
import {type MessageKey, useT} from '../i18n'
import {useStoreValue} from '../store'

const PAGE = 50
/** A finished download refreshes the page shown at most this often. */
const LIVE_MS = 2000
const SEARCH_MS = 250

/** A finished file: verified (a check ran), not checked (checksum only), checksum (older record), or gone / changed on disk. */
function FileTag({entry}: {readonly entry: FinishedEntry}) {
  const t = useT()
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
export function FinishedList() {
  const t = useT()
  const {settings} = useApp()
  const {message} = AntApp.useApp()
  const lang = settings.language
  // only the number of finished jobs: one re-render per completion, not per event
  const finishedNow = useStoreValue(store => store.counts.completed + store.counts.skipped)
  const [page, setPage] = useState(1)
  const [typed, setTyped] = useState('')
  const [search, setSearch] = useState('')
  const [data, setData] = useState<FinishedPage | undefined>()
  const [loading, setLoading] = useState(true)
  const latest = useRef(0)

  const load = useCallback(
    async (quiet = false) => {
      const request = ++latest.current
      if (!quiet) setLoading(true)
      try {
        const result = await api().finished({offset: (page - 1) * PAGE, limit: PAGE, search: search || undefined})
        // an answer to an older request (another page, another search) is dropped
        if (request === latest.current) setData(result)
      } finally {
        if (request === latest.current) setLoading(false)
      }
    },
    [page, search],
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
    <Space direction="vertical" className="full" data-testid="finished-list">
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
        <Button icon={<FolderOpenOutlined />} onClick={() => void api().openFolder('downloads')}>
          {t('finished.openDownloads')}
        </Button>
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
        scroll={{y: 420, x: 900}}
        locale={{
          emptyText: <Empty description={empty && search ? t('finished.noMatch') : t('finished.empty')} />,
        }}
        rowClassName={entry => (entry.file === 'ok' ? 'finished-row' : 'finished-row finished-gone')}
        columns={[
          {
            title: t('job.title'),
            key: 'title',
            ellipsis: true,
            render: (_, entry) => (
              <Space direction="vertical" size={0} className="job-title">
                <Typography.Text className="one-line" title={entry.title}>
                  {entry.title}
                </Typography.Text>
                <Typography.Text type="secondary" className="one-line mono" title={entry.filepath}>
                  {entry.extractor} · {entry.filepath.split(/[\\/]/).at(-1)}
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: t('finished.col.finishedAt'),
            key: 'at',
            width: 170,
            render: (_, entry) => moment(entry.completedAt, lang),
          },
          {title: '⏱', key: 'length', width: 80, align: 'right', render: (_, entry) => clock(entry.duration)},
          {
            title: t('finished.col.size'),
            key: 'size',
            width: 100,
            align: 'right',
            render: (_, entry) => bytes(entry.sizeBytes, lang),
          },
          {title: t('job.integrity'), key: 'integrity', width: 150, render: (_, entry) => <FileTag entry={entry} />},
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
