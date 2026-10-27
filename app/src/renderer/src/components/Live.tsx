import {DeleteOutlined, EyeOutlined, PlayCircleOutlined, SaveOutlined} from '@ant-design/icons'
import {App as AntApp, Button, Card, Modal, Popconfirm, Space, Tag, Typography} from 'antd'
import Hls from 'hls.js'
import type {JobSnapshot, RecordingSummary} from 'media-downloader-core'
import {useEffect, useRef, useState, useSyncExternalStore} from 'react'
import type {Preview, QuitChoice} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {bytes, clock, errorText, moment, rate} from '../format'
import {type MessageKey, type Translate, useT} from '../i18n'
import {useAppStore, useStoreValue} from '../store'

/** A channel on the air, as its preview says. */
type LivePreview = Extract<Preview, {kind: 'video'}> & {
  readonly live: NonNullable<Extract<Preview, {kind: 'video'}>['live']>
}

// ─── the player: one at a time, opened from the preview or from a recording ──────────────────

type Watching = {readonly url: string; readonly title: string} | undefined
let watching: Watching
const watchers = new Set<() => void>()
const subscribe = (listener: () => void) => {
  watchers.add(listener)
  return () => watchers.delete(listener)
}

/** Opens the live player on a channel (closing the one open). Independent of any recording. */
export function watchLive(url: string, title: string): void {
  watching = {url, title}
  for (const listener of watchers) listener()
}

function closePlayer(): void {
  watching = undefined
  for (const listener of watchers) listener()
}

/** The live player's host: mounted once in the app; shows the player while a channel is watched. */
export function LivePlayerHost() {
  const current = useSyncExternalStore(subscribe, () => watching)
  // the window going away closes the player too
  useEffect(() => closePlayer, [])
  return current ? <LivePlayer key={current.url} url={current.url} title={current.title} onClose={closePlayer} /> : null
}

/**
 * hls.js on the main process's proxy (`mdc-live:`): the session closes with the player. A fatal
 * error opens the stream once more (a signature that ran out), then offers Try again.
 * `capLevelToPlayerSize` keeps a small player from pulling 1080p60 beside a recording.
 */
function LivePlayer({
  url,
  title,
  onClose,
}: {
  readonly url: string
  readonly title: string
  readonly onClose: () => void
}) {
  const t = useT()
  const video = useRef<HTMLVideoElement>(null)
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)

  // biome-ignore lint/correctness/useExhaustiveDependencies: a new attempt (Try again) opens the stream anew
  useEffect(() => {
    let hls: Hls | undefined
    let sid: string | undefined
    let closed = false
    let reopened = false
    const release = () => {
      hls?.destroy()
      hls = undefined
      if (sid) void api().liveClose(sid)
      sid = undefined
    }
    const start = async (): Promise<void> => {
      const opened = await api().liveOpen(url)
      if (closed) {
        if (opened) void api().liveClose(opened.sid)
        return
      }
      if (!opened || !video.current || !Hls.isSupported()) {
        setFailed(true)
        return
      }
      sid = opened.sid
      const player = new Hls({
        lowLatencyMode: false,
        capLevelToPlayerSize: true,
        enableWorker: true,
        backBufferLength: 30,
      })
      hls = player
      player.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal || closed) return
        release()
        if (reopened) setFailed(true)
        else {
          reopened = true
          void start().catch(() => setFailed(true))
        }
      })
      player.loadSource(opened.src)
      player.attachMedia(video.current)
      // autoplay may be refused (no user gesture yet): the controls are there
      const element = video.current
      void Promise.resolve()
        .then(() => element.play())
        .catch(() => {})
    }
    setFailed(false)
    void start().catch(() => setFailed(true))
    return () => {
      closed = true
      release()
    }
  }, [url, attempt])

  return (
    <Modal open title={title} width={880} footer={null} onCancel={onClose} destroyOnHidden data-testid="live-player">
      {failed ? (
        <Space orientation="vertical" align="center" className="full" data-testid="live-player-error">
          <Typography.Text type="secondary">{t('live.playerError')}</Typography.Text>
          <Button onClick={() => setAttempt(n => n + 1)}>{t('live.retry')}</Button>
        </Space>
      ) : (
        // biome-ignore lint/a11y/useMediaCaption: a live stream has no captions to offer
        <video ref={video} className="live-video" controls autoPlay />
      )}
    </Modal>
  )
}

// ─── a channel just pasted: record it, watch it, or both ──────────────────────────────────────

export function isLivePreview(preview: Preview): preview is LivePreview {
  return preview.kind === 'video' && preview.live !== undefined
}

export function LiveModal({
  url,
  preview,
  onRecording,
  onClose,
}: {
  readonly url: string
  readonly preview: LivePreview
  readonly onRecording: () => void
  readonly onClose: () => void
}) {
  const t = useT()
  const {message} = AntApp.useApp()
  const {settings} = useApp()
  const store = useAppStore()
  const [busy, setBusy] = useState(false)
  const record = async () => {
    setBusy(true)
    try {
      const job = await api().record({
        url,
        format: settings.format,
        quality: settings.quality,
        outDir: settings.downloadDir,
      })
      store.addRecording(job)
      void message.success(t('live.recordStarted', {channel: preview.live.channel}))
      onRecording()
    } catch (error) {
      void message.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      title={
        <Space>
          <Tag color="red">{t('live.tag')}</Tag>
          {t('live.title')}
        </Space>
      }
      onCancel={onClose}
      data-testid="live-modal"
      footer={[
        <Button key="cancel" onClick={onClose}>
          {t('common.cancel')}
        </Button>,
        <Button key="watch" icon={<EyeOutlined />} onClick={() => watchLive(url, preview.title)}>
          {t('live.watch')}
        </Button>,
        <Button
          key="record"
          type="primary"
          danger
          icon={<PlayCircleOutlined />}
          loading={busy}
          onClick={() => void record()}
        >
          {t('live.record')}
        </Button>,
      ]}
    >
      <Space orientation="vertical" className="full">
        <Typography.Text strong>{preview.live.channel}</Typography.Text>
        <Typography.Text>{preview.title}</Typography.Text>
        {preview.live.startedAt ? (
          <Typography.Text type="secondary">
            {t('live.startedAt', {time: moment(preview.live.startedAt, settings.language)})}
          </Typography.Text>
        ) : null}
        <Typography.Text type="secondary">{t('live.intro')}</Typography.Text>
      </Space>
    </Modal>
  )
}

// ─── recordings running (or saving) ───────────────────────────────────────────────────────────

/** The recordings card, above the batches: shown only while something records. O(r) rows. */
export function RecordingsCard() {
  const t = useT()
  const {settings} = useApp()
  const recordings = useStoreValue(store => store.recordings)
  if (recordings.length === 0) return null
  return (
    <Card size="small" title={t('live.recordings')} className="recordings" data-testid="recordings">
      {recordings.map(job => (
        <RecordingRow key={job.id} job={job} t={t} locale={settings.language} />
      ))}
    </Card>
  )
}

function RecordingRow({job, t, locale}: {readonly job: JobSnapshot; readonly t: Translate; readonly locale: string}) {
  // running: REC and its clock; after Stop (or the stream's end): saving, like any download's last steps
  const recording = job.status === 'downloading' || job.status === 'queued'
  return (
    <div className="recording-row" data-testid="recording" data-status={job.status}>
      <Space wrap>
        {recording ? (
          <Tag color="red" className="rec-tag">
            ● {t('live.rec')}
          </Tag>
        ) : (
          <Tag color="processing">{t('live.saving')}</Tag>
        )}
        <Typography.Text strong className="one-line">
          {job.title ?? job.url}
        </Typography.Text>
        {job.progress.elapsedSec ? (
          <Typography.Text data-testid="recording-elapsed">
            {t('live.elapsed', {time: clock(job.progress.elapsedSec)})}
          </Typography.Text>
        ) : null}
        <Typography.Text type="secondary">
          {[bytes(job.progress.bytes ?? job.progress.downloadedBytes, locale), rate(job.progress.speed, locale)]
            .filter(Boolean)
            .join(' · ')}
        </Typography.Text>
      </Space>
      <Space>
        <Button icon={<EyeOutlined />} onClick={() => watchLive(job.url, job.title ?? job.url)}>
          {t('live.watch')}
        </Button>
        {recording ? (
          <>
            <Button
              type="primary"
              icon={<SaveOutlined />}
              onClick={() => void api().stopJob(job.id)}
              data-testid="recording-stop"
            >
              {t('live.stop')}
            </Button>
            <Popconfirm
              title={t('live.discardConfirm')}
              okText={t('live.discard')}
              okButtonProps={{danger: true}}
              cancelText={t('common.cancel')}
              onConfirm={() => void api().cancelJob(job.id)}
            >
              <Button danger icon={<DeleteOutlined />} data-testid="recording-discard">
                {t('live.discard')}
              </Button>
            </Popconfirm>
          </>
        ) : null}
      </Space>
    </div>
  )
}

/** How a recording ended, in one line: why, its gaps, the ads left out. */
export function recordingText(t: Translate, summary: RecordingSummary): string {
  const ended: MessageKey =
    summary.ended === 'endlist' ? 'live.ended.offline' : (`live.ended.${summary.ended}` as MessageKey)
  return [
    t(ended),
    summary.gaps ? t('live.gaps', {count: summary.gaps}) : undefined,
    summary.skippedSeconds >= 1 ? t('live.adsLeftOut', {time: clock(summary.skippedSeconds)}) : undefined,
  ]
    .filter(Boolean)
    .join(' · ')
}

// ─── quitting with recordings running ─────────────────────────────────────────────────────────

/** The main process asks before a quit that would cut recordings: save them, discard them, or stay. */
export function QuitRecordingModal() {
  const t = useT()
  const [count, setCount] = useState(0)
  const [busy, setBusy] = useState<QuitChoice | undefined>()
  useEffect(() => api().onQuitRequested(recordings => setCount(recordings)), [])
  const choose = async (choice: QuitChoice) => {
    if (choice === 'keep') {
      setCount(0)
      return void api().quitWith('keep')
    }
    setBusy(choice)
    await api().quitWith(choice)
  }
  // mounted only while asking: an answer takes it away at once
  if (count === 0) return null
  return (
    <Modal
      open
      title={t('live.quit.title')}
      closable={!busy}
      mask={{closable: false}}
      onCancel={() => void choose('keep')}
      data-testid="quit-recording"
      footer={[
        <Button key="keep" disabled={busy !== undefined} onClick={() => void choose('keep')}>
          {t('live.quit.keep')}
        </Button>,
        <Button
          key="discard"
          danger
          loading={busy === 'discard'}
          disabled={busy === 'save'}
          onClick={() => void choose('discard')}
        >
          {t('live.quit.discard')}
        </Button>,
        <Button
          key="save"
          type="primary"
          loading={busy === 'save'}
          disabled={busy === 'discard'}
          onClick={() => void choose('save')}
        >
          {t('live.quit.save')}
        </Button>,
      ]}
    >
      <Typography.Text>{t('live.quit.text', {count})}</Typography.Text>
    </Modal>
  )
}
