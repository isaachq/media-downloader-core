import {Drawer, Empty, Input, List, Tabs, Tag, Typography} from 'antd'
import type {LogEntry} from 'media-downloader-core'
import {useState} from 'react'
import {api} from '../api'
import {useT} from '../i18n'
import {useStore} from '../store'

const LEVEL_COLOR = {debug: 'default', info: 'blue', warn: 'warning', error: 'error'} as const

function LogLine({entry, full}: {readonly entry: LogEntry; readonly full?: boolean}) {
  const time = new Date(entry.time).toLocaleTimeString()
  const ids = [
    entry.batchId && `batch ${entry.batchId}`,
    entry.jobId && `job ${entry.jobId}`,
    entry.attemptId && `attempt ${entry.attemptId}`,
  ]
  return (
    <List.Item className="log-line" data-level={entry.level}>
      <div className="full">
        <Typography.Text type="secondary" className="mono">
          {time}
        </Typography.Text>{' '}
        <Tag color={LEVEL_COLOR[entry.level]}>{entry.level.toUpperCase()}</Tag>
        {entry.attempt ? <Tag>{`#${entry.attempt}/${entry.maxAttempts}`}</Tag> : null}
        {entry.step ? <Tag>{entry.step}</Tag> : null}
        <Typography.Text>{entry.message}</Typography.Text>
        {full ? (
          <div className="mono log-ids">
            {ids.filter(Boolean).map(id => (
              <Typography.Text key={id as string} type="secondary" copyable={{text: (id as string).split(' ')[1]!}}>
                {id}{' '}
              </Typography.Text>
            ))}
          </div>
        ) : null}
      </div>
    </List.Item>
  )
}

/** Live log of this session, and a tracer that replays any id from the trace files. */
export function LogsDrawer({open, onClose}: {readonly open: boolean; readonly onClose: () => void}) {
  const t = useT()
  const store = useStore()
  const [results, setResults] = useState<{entries: readonly LogEntry[]; total: number} | undefined>()
  const [searching, setSearching] = useState(false)

  const search = async (id: string) => {
    const value = id.trim()
    if (value.length < 6) return
    setSearching(true)
    try {
      setResults(await api().searchLogs(value, 500))
    } finally {
      setSearching(false)
    }
  }

  const live = [...store.logs].reverse()
  return (
    <Drawer title={t('logs.title')} open={open} onClose={onClose} width={720}>
      <Tabs
        items={[
          {
            key: 'live',
            label: t('logs.live'),
            children: live.length ? (
              <List size="small" dataSource={live} renderItem={entry => <LogLine entry={entry} />} />
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
                  onSearch={value => void search(value)}
                />
                {results ? (
                  results.total ? (
                    <>
                      <Typography.Text type="secondary">
                        {t('logs.results', {shown: results.entries.length, total: results.total})}
                      </Typography.Text>
                      <List
                        size="small"
                        dataSource={[...results.entries]}
                        renderItem={entry => <LogLine entry={entry} full />}
                      />
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
