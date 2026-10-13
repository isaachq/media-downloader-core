import {
  CalendarOutlined,
  DeleteOutlined,
  FolderOpenOutlined,
  MoreOutlined,
  PlusOutlined,
  ReloadOutlined,
  SearchOutlined,
  SyncOutlined,
} from '@ant-design/icons'
import {
  Alert,
  App as AntApp,
  Button,
  Dropdown,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Progress,
  Segmented,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd'
import type {SubscriptionView, SyncRun, SyncSchedule} from 'media-downloader-core'
import {useCallback, useEffect, useState} from 'react'
import {AUDIO_FORMATS, type Format, type SyncCheck, type SyncFolder, VIDEO_FORMATS} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {errorText, moment} from '../format'
import {type MessageKey, type Translate, useT} from '../i18n'
import {useShowBatch} from './BatchFilter'
import {Rows} from './Rows'

const HOURS = Array.from({length: 24}, (_, h) => `${String(h).padStart(2, '0')}:00`)

/** "@name", "name" or a profile link → the account name; undefined when it isn't one. */
export function tiktokAccount(text: string): string | undefined {
  const value = text.trim()
  const linked = /^(?:https?:\/\/)?(?:www\.|m\.)?tiktok\.com\/@([\w.]{2,24})\/?(?:[?#].*)?$/i.exec(value)
  if (linked) return linked[1]
  return /^@?([\w.]{2,24})$/.exec(value)?.[1]
}

/** The folder a new account suggests: "<downloads>/TikTok-<name>", where a profile download puts its posts. */
export function suggestedFolder(downloadDir: string, user: string): string {
  const sep = downloadDir.includes('\\') && !downloadDir.includes('/') ? '\\' : '/'
  return `${downloadDir.replace(/[\\/]+$/, '')}${sep}TikTok-${user}`
}

function scheduleText(t: Translate, schedule: SyncSchedule): string {
  if (schedule.every === 'day') return t('sync.schedule.dailyAt', {at: schedule.at})
  if (schedule.every === 'hours') return t('sync.schedule.everyHours', {hours: schedule.hours})
  return t('sync.schedule.manual')
}

/** Daily at a time, every N hours, or on demand. */
function ScheduleField({
  value,
  onChange,
}: {
  readonly value: SyncSchedule
  readonly onChange: (next: SyncSchedule) => void
}) {
  const t = useT()
  const [at, setAt] = useState(value.every === 'day' ? value.at : '08:00')
  const [hours, setHours] = useState(value.every === 'hours' ? value.hours : 6)
  const pick = (every: SyncSchedule['every']) =>
    onChange(every === 'day' ? {every, at} : every === 'hours' ? {every, hours} : {every: 'manual'})
  return (
    <Space wrap>
      <Segmented
        aria-label={t('sync.field.schedule')}
        value={value.every}
        onChange={every => pick(every as SyncSchedule['every'])}
        options={[
          {value: 'day', label: t('sync.schedule.daily')},
          {value: 'hours', label: t('sync.schedule.hourly')},
          {value: 'manual', label: t('sync.schedule.manual')},
        ]}
      />
      {value.every === 'day' ? (
        <Select
          aria-label={t('sync.field.at')}
          value={at}
          onChange={next => {
            setAt(next)
            onChange({every: 'day', at: next})
          }}
          options={HOURS.map(hour => ({value: hour, label: hour}))}
          className="sync-time"
        />
      ) : null}
      {value.every === 'hours' ? (
        <InputNumber
          aria-label={t('sync.field.hours')}
          min={1}
          max={168}
          value={hours}
          onChange={next => {
            const valid = Math.min(168, Math.max(1, Math.round(next ?? 6)))
            setHours(valid)
            onChange({every: 'hours', hours: valid})
          }}
          suffix={t('sync.field.hoursUnit')}
          className="sync-hours"
        />
      ) : null}
    </Space>
  )
}

/** What the chosen folder holds: its format decides the sync's (a folder holds one format). */
function FolderFormat({info}: {readonly info: SyncFolder | undefined}) {
  const t = useT()
  if (!info) return null
  const formats = info.formats.map(format => format.toUpperCase()).join(', ')
  if (info.problem) {
    const key = info.formats.length > 1 ? 'sync.folder.mixed' : 'sync.folder.unsupported'
    return <Alert type="error" showIcon title={t(key, {formats})} data-testid="sync-folder-info" />
  }
  if (info.format) {
    return (
      <Alert
        type="success"
        showIcon
        title={t('sync.folder.has', {count: info.files, format: info.format.toUpperCase()})}
        data-testid="sync-folder-info"
      />
    )
  }
  return <Alert type="info" showIcon title={t('sync.folder.empty')} data-testid="sync-folder-info" />
}

/** A new account: who, which folder (suggested from the account), the format the folder decides, when. */
function AddAccount({onClose}: {readonly onClose: () => void}) {
  const t = useT()
  const {settings} = useApp()
  const {message} = AntApp.useApp()
  const [account, setAccount] = useState('')
  const [picked, setPicked] = useState<string | undefined>()
  const [info, setInfo] = useState<SyncFolder | undefined>()
  const [format, setFormat] = useState<Format>(settings.format)
  const [schedule, setSchedule] = useState<SyncSchedule>({every: 'day', at: '08:00'})
  const [busy, setBusy] = useState<'add' | 'sync' | undefined>()
  const user = tiktokAccount(account)
  const folder = picked ?? (user ? suggestedFolder(settings.downloadDir, user) : '')

  useEffect(() => {
    if (!folder) {
      setInfo(undefined)
      return
    }
    let current = true
    const timer = setTimeout(() => {
      void api()
        .syncFolder(folder)
        .then(found => current && setInfo(found))
    }, 200)
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [folder])

  const locked = info?.format
  const ready = Boolean(user && folder && info && !info.problem)
  const save = async (then: 'add' | 'sync') => {
    if (!user || !info) return
    setBusy(then)
    try {
      const added = await api().syncAdd({
        url: `https://www.tiktok.com/@${user}`,
        folder,
        ...(!locked && {format}),
        schedule,
      })
      onClose()
      if (then === 'sync') {
        void message.info(t('sync.firstSync', {user: added.user}))
        await api().syncRun(added.id, false)
      } else void message.success(t('sync.added'))
    } catch (error) {
      void message.error(errorText(error))
    } finally {
      setBusy(undefined)
    }
  }

  return (
    <Modal
      open
      title={t('sync.add')}
      onCancel={onClose}
      width={640}
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t('common.cancel')}
        </Button>,
        <Button key="add" disabled={!ready} loading={busy === 'add'} onClick={() => void save('add')}>
          {t('sync.addOnly')}
        </Button>,
        <Button
          key="sync"
          type="primary"
          icon={<SyncOutlined />}
          disabled={!ready}
          loading={busy === 'sync'}
          onClick={() => void save('sync')}
          data-testid="sync-save"
        >
          {t('sync.addAndSync')}
        </Button>,
      ]}
    >
      <Form layout="vertical" requiredMark={false}>
        <Form.Item
          label={t('sync.field.account')}
          validateStatus={account.trim() && !user ? 'error' : ''}
          help={account.trim() && !user ? t('sync.field.accountInvalid') : t('sync.field.accountHint')}
        >
          <Input
            autoFocus
            aria-label={t('sync.field.account')}
            placeholder="@name"
            value={account}
            onChange={event => setAccount(event.target.value)}
          />
        </Form.Item>
        <Form.Item label={t('sync.field.folder')} help={t('sync.field.folderHint')}>
          <Space.Compact block>
            <Input
              readOnly
              aria-label={t('sync.field.folder')}
              value={folder}
              placeholder={t('sync.field.folderPick')}
              className="mono"
            />
            <Button
              icon={<FolderOpenOutlined />}
              onClick={async () => {
                const chosen = await api().chooseFolder(folder || settings.downloadDir)
                if (chosen) setPicked(chosen)
              }}
            >
              {t('download.change')}
            </Button>
          </Space.Compact>
        </Form.Item>
        <Form.Item>
          <FolderFormat info={info} />
        </Form.Item>
        <Form.Item label={t('download.format')} help={locked ? t('sync.field.formatLocked') : undefined}>
          <Select
            aria-label={t('download.format')}
            value={locked ? (locked as Format) : format}
            disabled={Boolean(locked)}
            onChange={setFormat}
            options={[
              {
                label: t('download.video'),
                options: VIDEO_FORMATS.map(value => ({value, label: t(`format.${value}` as MessageKey)})),
              },
              {
                label: t('download.audio'),
                options: AUDIO_FORMATS.map(value => ({value, label: t(`format.${value}` as MessageKey)})),
              },
            ]}
          />
        </Form.Item>
        <Form.Item label={t('sync.field.schedule')} help={t('sync.field.scheduleHint')}>
          <ScheduleField value={schedule} onChange={setSchedule} />
        </Form.Item>
      </Form>
    </Modal>
  )
}

/** When an account syncs by itself. */
function EditSchedule({item, onClose}: {readonly item: SubscriptionView; readonly onClose: () => void}) {
  const t = useT()
  const {message} = AntApp.useApp()
  const [schedule, setSchedule] = useState<SyncSchedule>(item.schedule)
  return (
    <Modal
      open
      title={t('sync.editSchedule', {user: item.user})}
      onCancel={onClose}
      okText={t('common.save')}
      onOk={async () => {
        try {
          await api().syncUpdate(item.id, {schedule})
          onClose()
        } catch (error) {
          void message.error(errorText(error))
        }
      }}
    >
      <Space orientation="vertical" className="full">
        <ScheduleField value={schedule} onChange={setSchedule} />
        <Typography.Text type="secondary">{t('sync.field.scheduleHint')}</Typography.Text>
      </Space>
    </Modal>
  )
}

/** "Done · Oct 11, 22:54 · new: 3 · downloaded: 3 · in the folder: 835". */
function RunLine({run}: {readonly run: SyncRun}) {
  const t = useT()
  const {settings} = useApp()
  const showBatch = useShowBatch()
  const color =
    run.status === 'done' ? (run.failed ? 'warning' : 'success') : run.status === 'running' ? 'processing' : 'error'
  const counts = [
    t('sync.count.new', {count: run.new}),
    run.status === 'running' ? undefined : t('sync.count.downloaded', {count: run.downloaded}),
    run.failed ? t('sync.count.failed', {count: run.failed}) : undefined,
    t('sync.count.inFolder', {count: run.inFolder}),
    run.gone ? t('sync.count.gone', {count: run.gone}) : undefined,
  ]
  return (
    <Space size={[6, 2]} wrap data-testid="sync-last-run">
      <Tag color={color}>{t(`sync.run.${run.status}` as MessageKey)}</Tag>
      <Typography.Text type="secondary">{moment(run.startedAt, settings.language)}</Typography.Text>
      <Typography.Text>{counts.filter(Boolean).join(' · ')}</Typography.Text>
      {run.deep ? <Tag>{t('sync.deep')}</Tag> : null}
      {run.batchId ? (
        <span>
          <Button type="link" size="small" onClick={() => showBatch('jobs', run.batchId!)}>
            {t('tabs.jobs')}
          </Button>
          <Button type="link" size="small" onClick={() => showBatch('finished', run.batchId!)}>
            {t('tabs.finished')}
          </Button>
        </span>
      ) : null}
      {run.error ? <Typography.Text type="danger">{run.error}</Typography.Text> : null}
    </Space>
  )
}

/** One account: what it is doing, its last run, when it runs next; Sync now, and the rest in a menu. */
function Account({
  item,
  onCheck,
  onSchedule,
}: {
  readonly item: SubscriptionView
  readonly onCheck: (item: SubscriptionView, deep: boolean) => void
  readonly onSchedule: (item: SubscriptionView) => void
}) {
  const t = useT()
  const {settings} = useApp()
  const {message, modal} = AntApp.useApp()
  const [history, setHistory] = useState(false)
  const busy = item.state !== 'idle'
  const last = item.runs[0]
  const sync = async () => {
    try {
      const run = await api().syncRun(item.id, false)
      void message.info(run.new ? t('sync.started', {count: run.new}) : t('sync.upToDate'))
    } catch (error) {
      void message.error(errorText(error))
    }
  }
  const remove = () =>
    modal.confirm({
      title: t('sync.removeConfirm', {user: item.user}),
      content: t('sync.removeKeeps'),
      okText: t('sync.remove'),
      okButtonProps: {danger: true},
      onOk: () => api().syncRemove(item.id),
    })
  const listing = item.state === 'listing' ? item.progress : undefined
  return (
    <Flex vertical gap={4} className="sync-account" data-testid="sync-card" data-state={item.state}>
      <Flex justify="space-between" align="center" gap={8} wrap>
        <Space wrap size={[6, 4]}>
          <Typography.Text strong>@{item.user}</Typography.Text>
          <Tag>{item.profile.container.toUpperCase()}</Tag>
          <Tag color={item.schedule.every === 'manual' ? 'default' : 'blue'} icon={<CalendarOutlined />}>
            {scheduleText(t, item.schedule)}
          </Tag>
          {busy ? (
            <Tag icon={<SyncOutlined spin />} color="processing" data-testid="sync-state">
              {t(`sync.state.${item.state}` as MessageKey)}
            </Tag>
          ) : null}
        </Space>
        <Space>
          <Button
            type="primary"
            icon={<SyncOutlined spin={busy} />}
            disabled={busy}
            onClick={() => void sync()}
            data-testid="sync-run"
          >
            {t('sync.runNow')}
          </Button>
          <Dropdown
            trigger={['click']}
            menu={{
              items: [
                {key: 'check', icon: <SearchOutlined />, label: t('sync.check'), disabled: busy},
                {key: 'deep', icon: <ReloadOutlined />, label: t('sync.deepCheck'), disabled: busy},
                {key: 'schedule', icon: <CalendarOutlined />, label: t('sync.changeSchedule')},
                {key: 'folder', icon: <FolderOpenOutlined />, label: t('sync.openFolder')},
                {type: 'divider'},
                {key: 'remove', icon: <DeleteOutlined />, label: t('sync.remove'), danger: true, disabled: busy},
              ],
              onClick: ({key}) => {
                if (key === 'check' || key === 'deep') onCheck(item, key === 'deep')
                else if (key === 'schedule') onSchedule(item)
                else if (key === 'folder') void api().openFolder({syncId: item.id})
                else if (key === 'remove') remove()
              },
            }}
          >
            <Button icon={<MoreOutlined />} aria-label={t('sync.more')} data-testid="sync-more" />
          </Dropdown>
        </Space>
      </Flex>
      <Typography.Text type="secondary" className="one-line mono" title={item.folder}>
        {item.folder}
      </Typography.Text>
      {listing ? (
        <Flex align="center" gap={8}>
          <Typography.Text type="secondary">{t('sync.listing', {listed: listing.listed})}</Typography.Text>
          {listing.expected ? (
            <Progress
              percent={Math.min(100, Math.floor((listing.listed / listing.expected) * 100))}
              size="small"
              status="active"
              className="sync-progress"
            />
          ) : null}
        </Flex>
      ) : null}
      {last ? <RunLine run={last} /> : <Typography.Text type="secondary">{t('sync.never')}</Typography.Text>}
      <Space size={[12, 0]} wrap>
        {item.nextRunAt ? (
          <Typography.Text type="secondary" data-testid="sync-next">
            {t('sync.next', {at: moment(item.nextRunAt, settings.language)})}
          </Typography.Text>
        ) : null}
        {item.runs.length > 1 ? (
          <Button
            type="link"
            size="small"
            onClick={() => setHistory(!history)}
            aria-expanded={history}
            className="link-inline"
          >
            {t('sync.history', {count: item.runs.length})}
          </Button>
        ) : null}
      </Space>
      {history ? (
        <Table<SyncRun>
          size="small"
          rowKey="id"
          pagination={false}
          scroll={{x: 560}}
          dataSource={[...item.runs]}
          columns={[
            {
              title: t('sync.col.when'),
              key: 'when',
              render: (_, run) => moment(run.startedAt, settings.language),
              width: 180,
            },
            {
              title: t('sync.col.how'),
              key: 'how',
              render: (_, run) => t(`sync.trigger.${run.trigger}` as MessageKey),
              width: 120,
            },
            {title: t('sync.col.new'), dataIndex: 'new', width: 70, align: 'right'},
            {title: t('sync.col.downloaded'), dataIndex: 'downloaded', width: 100, align: 'right'},
            {title: t('sync.col.failed'), dataIndex: 'failed', width: 80, align: 'right'},
            {title: t('sync.col.status'), key: 'status', render: (_, run) => t(`sync.run.${run.status}` as MessageKey)},
          ]}
        />
      ) : null}
    </Flex>
  )
}

/** A check's result: what is new, without downloading; one click downloads it. */
function CheckResult({
  check,
  onClose,
}: {
  readonly check: {item: SubscriptionView; deep: boolean; result?: SyncCheck}
  readonly onClose: () => void
}) {
  const t = useT()
  const {message} = AntApp.useApp()
  const {item, deep, result} = check
  return (
    <Modal
      open
      title={`${t(deep ? 'sync.deepCheck' : 'sync.check')} · @${item.user}`}
      onCancel={onClose}
      okText={result?.new ? t('sync.downloadNew', {count: result.new}) : t('common.close')}
      okButtonProps={{disabled: !result}}
      onOk={async () => {
        onClose()
        if (!result?.new) return
        try {
          await api().syncRun(item.id, deep)
          void message.info(t('sync.started', {count: result.new}))
        } catch (error) {
          void message.error(errorText(error))
        }
      }}
      width={640}
    >
      {result ? (
        <Space orientation="vertical" className="full" data-testid="sync-check-result">
          <Typography.Text strong>
            {result.new ? t('sync.checkNew', {count: result.new}) : t('sync.upToDate')}
          </Typography.Text>
          <Typography.Text type="secondary">
            {t('sync.checkCounts', {listed: result.listed, inFolder: result.inFolder})}
            {result.caughtUp ? ` · ${t('sync.incremental')}` : ''}
          </Typography.Text>
          {result.gone ? <Alert type="warning" showIcon title={t('sync.goneHint', {count: result.gone})} /> : null}
          {result.sample.length ? (
            <Rows
              className="many-list"
              items={result.sample}
              rowKey={entry => entry.id}
              render={entry => (
                <Typography.Text className="one-line" title={entry.title}>
                  {entry.title}
                </Typography.Text>
              )}
            />
          ) : null}
        </Space>
      ) : (
        <Space>
          <SyncOutlined spin />
          <Typography.Text type="secondary">{t(deep ? 'sync.checkingDeep' : 'sync.checking')}</Typography.Text>
        </Space>
      )}
    </Modal>
  )
}

/**
 * Sync Up: TikTok accounts kept in step with folders. Add one (its folder may
 * already hold its posts, and decides the format), sync now or on a schedule,
 * check what is new without downloading. Each sync is an ordinary batch:
 * Batches, Downloads, Finished and the report show it like any other.
 */
export function SyncPanel() {
  const t = useT()
  const {message} = AntApp.useApp()
  const [items, setItems] = useState<readonly SubscriptionView[] | undefined>()
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<SubscriptionView | undefined>()
  const [check, setCheck] = useState<{item: SubscriptionView; deep: boolean; result?: SyncCheck} | undefined>()

  const load = useCallback(async () => setItems(await api().syncList()), [])
  useEffect(() => {
    void load()
    return api().onSync(event => {
      setItems(current => {
        if (!current) return current
        if (event.removed) return current.filter(item => item.id !== event.removed)
        const view = event.view
        if (!view) return current
        return current.some(item => item.id === view.id)
          ? current.map(item => (item.id === view.id ? view : item))
          : [...current, view]
      })
    })
  }, [load])

  const runCheck = async (item: SubscriptionView, deep: boolean) => {
    setCheck({item, deep})
    try {
      const result = await api().syncCheck(item.id, deep)
      setCheck(current => (current?.item.id === item.id ? {item, deep, result} : current))
    } catch (error) {
      setCheck(undefined)
      void message.error(errorText(error))
    }
  }

  return (
    <Flex vertical gap={12} data-testid="sync-panel">
      <Flex justify="space-between" align="center" wrap gap={8}>
        <Typography.Text type="secondary" className="sync-intro">
          {t('sync.intro')}
        </Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setAdding(true)} data-testid="sync-add">
          {t('sync.add')}
        </Button>
      </Flex>
      {items?.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('sync.empty')} /> : null}
      {items?.length ? (
        <Flex vertical className="sync-list">
          {items.map(item => (
            <Account
              key={item.id}
              item={item}
              onCheck={(target, deep) => void runCheck(target, deep)}
              onSchedule={setEditing}
            />
          ))}
        </Flex>
      ) : null}
      {adding ? <AddAccount onClose={() => setAdding(false)} /> : null}
      {editing ? <EditSchedule item={editing} onClose={() => setEditing(undefined)} /> : null}
      {check ? <CheckResult check={check} onClose={() => setCheck(undefined)} /> : null}
    </Flex>
  )
}
