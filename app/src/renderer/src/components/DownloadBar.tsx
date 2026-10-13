import {CloudDownloadOutlined, FolderOpenOutlined, ScheduleOutlined, SnippetsOutlined} from '@ant-design/icons'
import {App as AntApp, Button, Card, Col, Form, Input, Row, Select, Space, Typography} from 'antd'
import {type DragEvent, useRef, useState} from 'react'
import {
  AUDIO_FORMATS,
  concurrencyCap,
  type Format,
  isAudioFormat,
  platformOf,
  QUALITIES,
  type Quality,
  type ScheduleInput,
  VIDEO_FORMATS,
} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {errorText, extractUrls, isHttpUrl} from '../format'
import {type MessageKey, useT} from '../i18n'
import {mismatchText, modeName} from '../mode'
import {type AppStore, useAppStore, useStoreValue} from '../store'
import {AnalyzeLoader} from './AnalyzeLoader'
import {ManyLinksModal} from './ManyLinksModal'
import {type PlaylistPreview, type PreviewChoice, PreviewModal} from './PreviewModal'
import {SlideshowModal} from './SlideshowChoice'
import {SyncPanel} from './SyncPanel'

const ACTIVE = new Set(['checking', 'running', 'validating'])

/** Where a new batch would go in the line: 0 when nothing runs (it starts now). O(batches). */
function waitingPosition(store: AppStore): number {
  let active = 0
  let scheduled = 0
  for (const batch of store.batches.values()) {
    if (ACTIVE.has(batch.status)) active++
    else if (batch.status === 'scheduled') scheduled++
  }
  return active > 0 ? scheduled + 1 : 0
}

/**
 * URL in, batch out. Submitting never blocks: if a batch is running the new
 * one is scheduled behind it, and the bar says so before you click.
 */
export function DownloadBar() {
  const t = useT()
  const {message} = AntApp.useApp()
  const {info, settings, updateSettings} = useApp()
  const store = useAppStore()
  // the form re-renders when the line of batches changes, not on every progress event
  const waiting = useStoreValue(waitingPosition)
  const [section, setSection] = useState<'download' | 'sync'>('download')
  const [url, setUrl] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{url: string; data: PlaylistPreview} | undefined>()
  const [reloading, setReloading] = useState(false)
  /** Several links pasted or dropped at once, under review. */
  const [many, setMany] = useState<{urls: string[]; repeated: number; otherMode: number} | undefined>()
  const [dropping, setDropping] = useState(false)
  // set when the user stops the reading: its rejection is not an error to show
  const cancelled = useRef(false)

  const audio = isAudioFormat(settings.format)
  const mode = info.mode
  const http = isHttpUrl(url)
  // a link of another site than this run's: said under the field, before anything is asked
  const otherMode = http ? platformOf(url.trim(), info.siteAliases) : undefined
  const wrongMode = otherMode !== undefined && otherMode !== mode
  const valid = http && !wrongMode

  const fail = (error: unknown) => {
    const mismatch = mismatchText(t, error, mode)
    if (mismatch) {
      void message.error(mismatch)
      return
    }
    const text = errorText(error)
    // YouTube's bot check: one line here; the banner above says when it goes on, and how to go on now
    if (/not a (?:ro)?bot/i.test(text)) void message.error(t('hint.bot-check'))
    // a site that keeps this for signed-in accounts: say how to sign in (the browser's session)
    else if (/asks to sign in|sign-in required|login required/i.test(text))
      void message.error(`${text} ${t('hint.needs-sign-in')}`)
    else void message.error(text)
  }

  const slideshow = {mode: settings.slideshowMode, secondsPerImage: settings.slideshowSeconds}
  /** A single slideshow link waiting for its choice. */
  const [slide, setSlide] = useState<{url: string; title: string} | undefined>()

  const schedule = async (target: string, extra: Pick<ScheduleInput, 'selection'> = {}) => {
    const batch = await api().schedule({
      url: target,
      format: settings.format,
      quality: settings.quality,
      outDir: settings.downloadDir,
      slideshow,
      ...extra,
    })
    store.apply({batches: [batch], jobs: [], items: [], logs: []})
    void message.success(t('download.scheduled', {title: extra.selection?.title ?? batch.url}))
    setUrl('')
    setTouched(false)
  }

  // a single video starts right away; a list opens the preview to pick from
  const submit = async () => {
    setTouched(true)
    if (!valid || busy) return
    setBusy(true)
    cancelled.current = false
    const target = url.trim()
    try {
      const result = await api().analyze(target)
      if (result.kind === 'playlist') setPreview({url: target, data: result})
      // a slideshow with a video format: first, what it should become
      else if (result.slideshow && !audio) setSlide({url: target, title: result.title})
      else await schedule(target)
    } catch (error) {
      if (!cancelled.current) fail(error)
    } finally {
      setBusy(false)
    }
  }

  const reload = async (maxItems: number) => {
    if (!preview) return
    setReloading(true)
    cancelled.current = false
    try {
      const result = await api().analyze(preview.url, maxItems)
      if (result.kind === 'playlist') setPreview({url: preview.url, data: result})
    } catch (error) {
      if (!cancelled.current) fail(error)
    } finally {
      setReloading(false)
    }
  }

  const confirm = async (choice: PreviewChoice) => {
    if (!preview) return
    const listUrl = preview.url
    setPreview(undefined)
    try {
      if (choice.kind === 'video') await schedule(choice.url)
      else await schedule(listUrl, {selection: {title: choice.title, entries: choice.entries}})
    } catch (error) {
      fail(error)
    }
  }

  /**
   * One link fills the field; several open the review of many links — only
   * this mode's (the others are counted, not scheduled). True when it took the text.
   */
  const take = (text: string): boolean => {
    const found = extractUrls(text)
    if (found.urls.length < 2) return false
    const ours = found.urls.filter(link => platformOf(link, info.siteAliases) === mode)
    setMany({urls: ours, repeated: found.repeated, otherMode: found.urls.length - ours.length})
    return true
  }

  const paste = async () => {
    const text = await navigator.clipboard?.readText().catch(() => '')
    if (text && !take(text)) setUrl(text.trim())
  }

  const scheduleMany = async (urls: readonly string[]) => {
    let scheduled = 0
    for (const target of urls) {
      try {
        const batch = await api().schedule({
          url: target,
          format: settings.format,
          quality: settings.quality,
          outDir: settings.downloadDir,
        })
        store.apply({batches: [batch], jobs: [], items: [], logs: []})
        scheduled++
      } catch (error) {
        fail(error)
      }
    }
    setMany(undefined)
    void message.success(t('many.scheduled', {count: scheduled}))
  }

  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setDropping(false)
    const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
    if (!text || take(text)) return
    const [single] = extractUrls(text).urls
    if (single) setUrl(single)
  }

  const sections = {
    tabList: [
      {key: 'download', label: t('download.title')},
      {key: 'sync', label: t('sync.title')},
    ],
    activeTabKey: section,
    onTabChange: (key: string) => setSection(key as 'download' | 'sync'),
  }

  const chooseFolder = async () => {
    const folder = await api().chooseFolder(settings.downloadDir)
    if (folder) await updateSettings({downloadDir: folder})
  }

  const formatOptions = [
    {label: t('download.video'), options: VIDEO_FORMATS.map(f => ({value: f, label: t(`format.${f}` as MessageKey)}))},
    {label: t('download.audio'), options: AUDIO_FORMATS.map(f => ({value: f, label: t(`format.${f}` as MessageKey)}))},
  ]
  const qualityOptions = QUALITIES.map(q => ({value: q, label: q === 'best' ? t('quality.best') : `${q}p`}))
  const cap = concurrencyCap(info, settings)
  const longAtOnce = Math.max(1, Math.floor(cap / 1.5))

  // TikTok mode only: the card has two sections, New download and Sync Up
  const withSync = mode === 'tiktok'
  const syncing = withSync && section === 'sync'
  if (syncing) {
    return (
      <Card className="download-card" {...sections}>
        <SyncPanel />
      </Card>
    )
  }

  return (
    <Card
      className={dropping ? 'download-card dropping' : 'download-card'}
      {...(withSync ? sections : {title: t('download.titleMode', {mode: modeName(t, mode)})})}
      onDragOver={event => {
        event.preventDefault()
        setDropping(true)
      }}
      onDragLeave={() => setDropping(false)}
      onDrop={drop}
      data-drop-hint={t('many.drop')}
    >
      <Form layout="vertical" onFinish={() => void submit()} requiredMark={false}>
        <Form.Item
          label={t(`download.url.${mode}` as MessageKey)}
          validateStatus={(touched && !valid) || wrongMode ? 'error' : ''}
          help={
            wrongMode
              ? t('mode.wrongLink', {site: modeName(t, otherMode), mode: modeName(t, mode)})
              : touched && !valid
                ? t('download.invalidUrl')
                : undefined
          }
        >
          <Space.Compact block data-tour="url">
            <Input
              size="large"
              allowClear
              aria-label={t('download.url')}
              placeholder={t(`download.urlPlaceholder.${mode}` as MessageKey)}
              value={url}
              onChange={event => setUrl(event.target.value)}
              onPaste={event => {
                if (take(event.clipboardData.getData('text'))) event.preventDefault()
              }}
              onBlur={() => setTouched(url.length > 0)}
            />
            <Button size="large" icon={<SnippetsOutlined />} onClick={() => void paste()}>
              {t('download.paste')}
            </Button>
          </Space.Compact>
        </Form.Item>
        <Row gutter={12} align="bottom" data-tour="options">
          <Col xs={24} md={8}>
            <Form.Item label={t('download.format')}>
              <Select
                aria-label={t('download.format')}
                value={settings.format}
                options={formatOptions}
                onChange={(value: Format) => void updateSettings({format: value})}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={5}>
            <Form.Item label={t('download.quality')}>
              <Select
                aria-label={t('download.quality')}
                value={audio ? 'best' : settings.quality}
                disabled={audio}
                options={audio ? [{value: 'best', label: t('download.qualityAudio')}] : qualityOptions}
                onChange={(value: Quality) => void updateSettings({quality: value})}
              />
            </Form.Item>
          </Col>
          <Col xs={24} md={7}>
            <Form.Item label={t('download.folder')}>
              <Space.Compact block>
                <Input
                  readOnly
                  value={settings.downloadDir}
                  aria-label={t('download.folder')}
                  title={settings.downloadDir}
                />
                <Button icon={<FolderOpenOutlined />} onClick={() => void chooseFolder()}>
                  {t('download.change')}
                </Button>
              </Space.Compact>
            </Form.Item>
          </Col>
          <Col xs={24} md={4}>
            <Form.Item>
              <Button
                type="primary"
                htmlType="submit"
                size="large"
                block
                data-tour="download"
                loading={busy}
                icon={waiting ? <ScheduleOutlined /> : <CloudDownloadOutlined />}
              >
                {busy ? t('download.analyzing') : waiting ? t('download.schedule') : t('download.start')}
              </Button>
            </Form.Item>
          </Col>
        </Row>
      </Form>
      {busy ? (
        <AnalyzeLoader
          onCancel={() => {
            cancelled.current = true
            void api().cancelAnalyze()
          }}
        />
      ) : null}
      <Typography.Text type="secondary" className="download-hint">
        {waiting
          ? t('download.scheduledHint', {position: waiting})
          : t('download.capacity', {normal: cap, cpus: info.cpus, long: longAtOnce})}
      </Typography.Text>
      {slide ? (
        <SlideshowModal
          title={slide.title}
          onConfirm={() => {
            const target = slide.url
            setSlide(undefined)
            void schedule(target).catch(fail)
          }}
          onCancel={() => setSlide(undefined)}
        />
      ) : null}
      {many ? (
        <ManyLinksModal
          urls={many.urls}
          repeated={many.repeated}
          otherMode={many.otherMode}
          onSchedule={scheduleMany}
          onCancel={() => setMany(undefined)}
        />
      ) : null}
      {preview ? (
        <PreviewModal
          // a reload brings a new list: start its selection afresh
          key={`${preview.data.maxItems}:${preview.data.entries.length}`}
          preview={preview.data}
          loading={reloading}
          onReload={maxItems => void reload(maxItems)}
          onStopReload={() => {
            cancelled.current = true
            void api().cancelAnalyze()
          }}
          onConfirm={choice => void confirm(choice)}
          onCancel={() => setPreview(undefined)}
        />
      ) : null}
    </Card>
  )
}
