import {
  CloudDownloadOutlined,
  FolderOpenOutlined,
  OrderedListOutlined,
  ScheduleOutlined,
  SnippetsOutlined,
} from '@ant-design/icons'
import {App as AntApp, Button, Card, Col, Form, Input, Modal, Row, Select, Space, Tag, Typography} from 'antd'
import {type DragEvent, useMemo, useRef, useState} from 'react'
import {
  AUDIO_FORMATS,
  concurrencyCap,
  detectLink,
  type Format,
  isAudioFormat,
  planMix,
  QUALITIES,
  type Quality,
  type ScheduleInput,
  VIDEO_FORMATS,
} from '../../../shared/contract'
import {SITES} from '../../../shared/sites'
import {api} from '../api'
import {useApp} from '../context'
import {errorText} from '../format'
import {type MessageKey, useT} from '../i18n'
import {type AppStore, useAppStore, useStoreValue} from '../store'
import {AnalyzeLoader} from './AnalyzeLoader'
import {isLivePreview, LiveModal} from './Live'
import {MixListModal} from './MixListModal'
import {type PlaylistPreview, type PreviewChoice, PreviewModal} from './PreviewModal'
import {SiteTag} from './SiteTag'
import {SlideshowModal} from './SlideshowChoice'
import {SiteLine, SupportedSites} from './SupportedSites'
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
  /** A mix list being put together: several links pasted or dropped at once (checked at once), or the button. */
  const [mix, setMix] = useState<{readonly text: string; readonly check: boolean} | undefined>()
  const [dropping, setDropping] = useState(false)
  const [sitesOpen, setSitesOpen] = useState(false)
  // set when the user stops the reading: its rejection is not an error to show
  const cancelled = useRef(false)

  const audio = isAudioFormat(settings.format)
  // the site of the link in the field (found in shared text too, unwrapped from a
  // tracker): once per change of the text, not per render
  const detected = useMemo(() => detectLink(url, info.siteAliases), [url, info.siteAliases])
  const valid = detected !== undefined

  const fail = (error: unknown) => {
    const text = errorText(error)
    // YouTube's bot check: one line here; the banner above says when it goes on, and how to go on now
    if (/not a (?:ro)?bot/i.test(text)) void message.error(t('hint.bot-check'))
    // a site that keeps this for signed-in accounts: say how to sign in (the browser's session)
    // (Twitch, Threads, Bluesky and VK say "signed-in account / session" or "watched signed in")
    else if (
      /asks to sign in|sign-in required|login required|signed-in (?:account|session)|watched signed in/i.test(text)
    )
      void message.error(`${text} ${t('hint.needs-sign-in')}`)
    else void message.error(text)
  }

  const slideshow = {mode: settings.slideshowMode, secondsPerImage: settings.slideshowSeconds}
  /** A single slideshow link waiting for its choice. */
  const [slide, setSlide] = useState<{url: string; title: string} | undefined>()
  /** A Twitch channel on the air: recorded or watched, never scheduled as a download. */
  const [live, setLive] = useState<{url: string; preview: Parameters<typeof LiveModal>[0]['preview']} | undefined>()

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
    if (!detected || busy) return
    setBusy(true)
    cancelled.current = false
    const target = detected.url
    try {
      const result = await api().analyze(target)
      if (result.kind === 'playlist') setPreview({url: target, data: result})
      else if (isLivePreview(result)) setLive({url: target, preview: result})
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
   * One link fills the field; several, of whatever sites, become a mix list —
   * checked at once, then downloaded as one batch. True when it took the text.
   */
  const take = (text: string): boolean => {
    if (planMix(text, {aliases: info.siteAliases, maxLinks: 2}).links.length < 2) return false
    setMix({text, check: true})
    return true
  }

  const paste = async () => {
    const text = await navigator.clipboard?.readText().catch(() => '')
    if (text && !take(text)) setUrl(text.trim())
  }

  const drop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault()
    setDropping(false)
    const text = event.dataTransfer.getData('text/uri-list') || event.dataTransfer.getData('text/plain')
    if (!text || take(text)) return
    const [single] = planMix(text, {aliases: info.siteAliases, maxLinks: 1}).links
    if (single) setUrl(single.url)
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

  // two sections: New download and Sync Up (TikTok accounts kept in step with folders)
  if (section === 'sync') {
    return (
      <Card className="download-card" {...sections}>
        <SyncPanel />
      </Card>
    )
  }

  return (
    <Card
      className={dropping ? 'download-card dropping' : 'download-card'}
      {...sections}
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
          label={
            <span>
              {t('download.urlLabel', {count: SITES.length})}{' '}
              <Typography.Link
                data-testid="open-sites"
                onClick={event => {
                  // the link sits in the field's label: it opens the list, not the field
                  event.preventDefault()
                  setSitesOpen(true)
                }}
              >
                {t('sites.title')}
              </Typography.Link>
            </span>
          }
          validateStatus={touched && !valid ? 'error' : ''}
          help={touched && !valid ? t('download.invalidUrl') : undefined}
        >
          <Space.Compact block data-tour="url">
            <Input
              size="large"
              allowClear
              aria-label={t('download.url')}
              placeholder={t('download.urlPlaceholder')}
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
            <Button
              size="large"
              icon={<OrderedListOutlined />}
              onClick={() => setMix({text: url, check: false})}
              data-testid="open-mix"
              data-tour="mix"
            >
              {t('mix.open')}
            </Button>
          </Space.Compact>
        </Form.Item>
        {detected ? (
          <div className="link-tags" data-testid="link-tags">
            {/* a link straight to a media file of any other site is a file; a named site stays itself */}
            <SiteTag site={detected.file && detected.site === 'web' ? 'file' : detected.site} />
            {/playlist|\/sets\/|\/album\//i.test(detected.url) && <Tag color="gold">{t('download.tag.list')}</Tag>}
            {/@[\w.-]+/.test(detected.url) && <Tag color="lime">{t('download.tag.profile')}</Tag>}
            <SiteLine site={detected.file && detected.site === 'web' ? 'file' : detected.site} />
          </div>
        ) : null}
        <div style={{marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
          <Typography.Text type="secondary" style={{fontSize: 12}}>
            {t('download.presets')}
          </Typography.Text>
          <Space size={6} wrap>
            <Button
              size="small"
              disabled={busy}
              type={settings.format === 'mp4' && settings.quality === 'best' ? 'primary' : 'default'}
              onClick={() => void updateSettings({format: 'mp4', quality: 'best'})}
            >
              {t('download.preset.best')}
            </Button>
            <Button
              size="small"
              disabled={busy}
              type={settings.format === 'mp3' ? 'primary' : 'default'}
              onClick={() => void updateSettings({format: 'mp3'})}
            >
              {t('download.preset.audio')}
            </Button>
            <Button
              size="small"
              disabled={busy}
              type={settings.format === 'mp4' && settings.quality === '720' ? 'primary' : 'default'}
              onClick={() => void updateSettings({format: 'mp4', quality: '720'})}
            >
              {t('download.preset.balanced')}
            </Button>
          </Space>
        </div>
        <Row gutter={12} align="bottom" data-tour="options">
          <Col xs={24} md={8}>
            <Form.Item label={t('download.format')}>
              <Select
                aria-label={t('download.format')}
                disabled={busy}
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
                disabled={audio || busy}
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
                <Button disabled={busy} icon={<FolderOpenOutlined />} onClick={() => void chooseFolder()}>
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
      {live ? (
        <LiveModal
          url={live.url}
          preview={live.preview}
          onRecording={() => {
            setLive(undefined)
            setUrl('')
            setTouched(false)
          }}
          onClose={() => setLive(undefined)}
        />
      ) : null}
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
      <Modal
        open={sitesOpen}
        title={t('sites.title')}
        width={860}
        footer={null}
        onCancel={() => setSitesOpen(false)}
        destroyOnHidden
      >
        <SupportedSites />
      </Modal>
      {mix ? (
        <MixListModal
          text={mix.text}
          check={mix.check}
          onScheduled={batch => {
            store.apply({batches: [batch], jobs: [], items: [], logs: []})
            setUrl('')
            setTouched(false)
          }}
          onClose={() => setMix(undefined)}
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
