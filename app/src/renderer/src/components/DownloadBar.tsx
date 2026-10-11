import {CloudDownloadOutlined, FolderOpenOutlined, ScheduleOutlined, SnippetsOutlined} from '@ant-design/icons'
import {App as AntApp, Button, Card, Col, Form, Input, Row, Select, Space, Typography} from 'antd'
import {useMemo, useRef, useState} from 'react'
import {
  AUDIO_FORMATS,
  type Format,
  isAudioFormat,
  QUALITIES,
  type Quality,
  type ScheduleInput,
  VIDEO_FORMATS,
} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {isHttpUrl} from '../format'
import {type MessageKey, useT} from '../i18n'
import {useStore} from '../store'
import {AnalyzeLoader} from './AnalyzeLoader'
import {type PlaylistPreview, type PreviewChoice, PreviewModal} from './PreviewModal'

const ACTIVE = new Set(['checking', 'running'])

/**
 * URL in, batch out. Submitting never blocks: if a batch is running the new
 * one is scheduled behind it, and the bar says so before you click.
 */
export function DownloadBar() {
  const t = useT()
  const {message} = AntApp.useApp()
  const {info, settings, updateSettings} = useApp()
  const store = useStore()
  const version = store.version
  const [url, setUrl] = useState('')
  const [touched, setTouched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [preview, setPreview] = useState<{url: string; data: PlaylistPreview} | undefined>()
  const [reloading, setReloading] = useState(false)
  // set when the user stops the reading: its rejection is not an error to show
  const cancelled = useRef(false)

  const audio = isAudioFormat(settings.format)
  const valid = isHttpUrl(url)
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when the store changes
  const waiting = useMemo(() => {
    let active = 0
    let scheduled = 0
    for (const batch of store.batches.values()) {
      if (ACTIVE.has(batch.status)) active++
      else if (batch.status === 'scheduled') scheduled++
    }
    return active > 0 ? scheduled + 1 : 0
  }, [version])

  const fail = (error: unknown) => void message.error(error instanceof Error ? error.message : String(error))

  const schedule = async (target: string, extra: Pick<ScheduleInput, 'selection'> = {}) => {
    const batch = await api().schedule({
      url: target,
      format: settings.format,
      quality: settings.quality,
      outDir: settings.downloadDir,
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
    try {
      const result = await api().analyze(preview.url, maxItems)
      if (result.kind === 'playlist') setPreview({url: preview.url, data: result})
    } catch (error) {
      fail(error)
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

  const paste = async () => {
    const text = await navigator.clipboard?.readText().catch(() => '')
    if (text) setUrl(text.trim())
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
  const longAtOnce = Math.max(1, Math.floor(info.maxConcurrency / 1.5))

  return (
    <Card className="download-card" title={t('download.title')}>
      <Form layout="vertical" onFinish={() => void submit()} requiredMark={false}>
        <Form.Item
          label={t('download.url')}
          validateStatus={touched && !valid ? 'error' : ''}
          help={touched && !valid ? t('download.invalidUrl') : undefined}
        >
          <Space.Compact block>
            <Input
              size="large"
              allowClear
              aria-label={t('download.url')}
              placeholder={t('download.urlPlaceholder')}
              value={url}
              onChange={event => setUrl(event.target.value)}
              onBlur={() => setTouched(url.length > 0)}
            />
            <Button size="large" icon={<SnippetsOutlined />} onClick={() => void paste()}>
              {t('download.paste')}
            </Button>
          </Space.Compact>
        </Form.Item>
        <Row gutter={12} align="bottom">
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
          : t('download.capacity', {normal: info.maxConcurrency, cpus: info.cpus, long: longAtOnce})}
      </Typography.Text>
      {preview ? (
        <PreviewModal
          // a reload brings a new list: start its selection afresh
          key={`${preview.data.maxItems}:${preview.data.entries.length}`}
          preview={preview.data}
          loading={reloading}
          onReload={maxItems => void reload(maxItems)}
          onConfirm={choice => void confirm(choice)}
          onCancel={() => setPreview(undefined)}
        />
      ) : null}
    </Card>
  )
}
