import {CopyOutlined} from '@ant-design/icons'
import {App as AntApp, Button, Drawer, Empty, Input, Tabs, Tag, Typography} from 'antd'
import type {LogEntry} from 'media-downloader-core'
import {memo, useCallback, useState} from 'react'
import {api} from '../api'
import {useT} from '../i18n'
import {useStore} from '../store'

const LEVEL_COLOR = {debug: 'default', info: 'blue', warn: 'warning', error: 'error'} as const
const ID_FIELDS = [
  ['batch', 'batchId'],
  ['job', 'jobId'],
  ['attempt', 'attemptId'],
  ['step', 'stepId'],
] as const
/** Live lines rendered at once; older ones on request. */
const PAGE = 200

/**
 * One log entry: time, level, message and every trace id it carries (click =
 * trace, icon = copy). Memoized and built from plain elements: entries never
 * change, so a new log line renders one row, not the whole list.
 */
const LogLine = memo(function LogLine({
  entry,
  onTrace,
  onCopy,
}: {
  readonly entry: LogEntry
  readonly onTrace: (id: string) => void
  readonly onCopy: (id: string) => void
}) {
  return (
    <div className="log-line" data-level={entry.level}>
      <span className="mono log-time">{new Date(entry.time).toLocaleTimeString()}</span>
      <Tag color={LEVEL_COLOR[entry.level]}>{entry.level.toUpperCase()}</Tag>
      {entry.attempt ? <span className="log-chip">{`#${entry.attempt}/${entry.maxAttempts}`}</span> : null}
      {entry.step ? <span className="log-chip">{entry.step}</span> : null}
      <span className="log-message">{entry.message}</span>
      {entry.batchId || entry.jobId ? (
        <div className="mono log-ids" data-testid="log-ids">
          {ID_FIELDS.map(([label, field]) => {
            const id = entry[field]
            return id ? (
              <span key={label} className="log-id">
                <span className="log-id-label">{label}</span>
                <button type="button" className="log-id-link" title={id} onClick={() => onTrace(id)}>
                  {id}
                </button>
                <button type="button" className="log-copy" aria-label={`copy ${label} id`} onClick={() => onCopy(id)}>
                  <CopyOutlined />
                </button>
              </span>
            ) : null
          })}
        </div>
      ) : null}
    </div>
  )
})

/** Live log of this session, and a tracer that replays any id from the trace files. */
export function LogsDrawer({open, onClose}: {readonly open: boolean; readonly onClose: () => void}) {
  const t = useT()
  const {message} = AntApp.useApp()
  const store = useStore()
  const [results, setResults] = useState<{entries: readonly LogEntry[]; total: number} | undefined>()
  const [searching, setSearching] = useState(false)
  const [tab, setTab] = useState<'live' | 'trace'>('live')
  const [query, setQuery] = useState('')
  const [shown, setShown] = useState(PAGE)

  const search = useCallback(async (id: string) => {
    const value = id.trim()
    if (value.length < 6) return
    setSearching(true)
    try {
      setResults(await api().searchLogs(value, 500))
    } finally {
      setSearching(false)
    }
  }, [])

  const trace = useCallback(
    (id: string) => {
      setQuery(id)
      setTab('trace')
      void search(id)
    },
    [search],
  )

  const copy = useCallback(
    (id: string) => {
      void navigator.clipboard?.writeText(id).then(() => message.success(t('logs.copied')))
    },
    [message, t],
  )

  // newest first, only the visible page: O(PAGE) per update
  const {logs} = store
  const live: LogEntry[] = []
  for (let i = logs.length - 1; i >= 0 && live.length < shown; i--) live.push(logs[i]!)
  const older = logs.length - live.length

  return (
    // unmounted while closed: a hidden drawer must not re-render on every event
    <Drawer title={t('logs.title')} open={open} onClose={onClose} width={720} destroyOnHidden>
      <Tabs
        activeKey={tab}
        onChange={key => setTab(key as 'live' | 'trace')}
        items={[
          {
            key: 'live',
            label: t('logs.live'),
            children: live.length ? (
              <>
                <Typography.Text type="secondary">{t('logs.traceHint')}</Typography.Text>
                <div className="log-list">
                  {live.map(entry => (
                    <LogLine key={store.logKey(entry)} entry={entry} onTrace={trace} onCopy={copy} />
                  ))}
                </div>
                {older > 0 ? (
                  <Button block type="dashed" onClick={() => setShown(n => n + PAGE)}>
                    {t('logs.older', {count: older})}
                  </Button>
                ) : null}
              </>
            ) : (
              <Empty description={t('logs.empty')} />
            ),
          },
          {
            key: 'trace',
            label: t('logs.search'),
            children: (
              <>
                <Input.Search
                  aria-label={t('logs.search')}
                  placeholder={t('logs.searchPlaceholder')}
                  enterButton
                  loading={searching}
                  value={query}
                  onChange={event => setQuery(event.target.value)}
                  onSearch={value => void search(value)}
                />
                {results ? (
                  results.total ? (
                    <>
                      <Typography.Text type="secondary">
                        {t('logs.results', {shown: results.entries.length, total: results.total})}
                      </Typography.Text>
                      <div className="log-list">
                        {results.entries.map((entry, i) => (
                          // results are replaced as a whole: their position is a stable key
                          // biome-ignore lint/suspicious/noArrayIndexKey: immutable result page
                          <LogLine key={i} entry={entry} onTrace={trace} onCopy={copy} />
                        ))}
                      </div>
                    </>
                  ) : (
                    <Empty description={t('logs.noResults')} />
                  )
                ) : null}
              </>
            ),
          },
        ]}
      />
    </Drawer>
  )
}
