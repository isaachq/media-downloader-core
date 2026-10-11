import {CloudDownloadOutlined, FolderOpenOutlined, ScheduleOutlined, SnippetsOutlined} from '@ant-design/icons'
import {App as AntApp, Button, Card, Col, Form, Input, Row, Select, Space, Typography} from 'antd'
import {useMemo, useState} from 'react'
import {
  AUDIO_FORMATS,
  type Format,
  isAudioFormat,
  QUALITIES,
  type Quality,
  VIDEO_FORMATS,
} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {isHttpUrl} from '../format'
import {type MessageKey, useT} from '../i18n'
import {useStore} from '../store'

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

  const submit = async () => {
    setTouched(true)
    if (!valid || busy) return
    setBusy(true)
    try {
      const batch = await api().schedule({
        url: url.trim(),
        format: settings.format,
        quality: settings.quality,
        outDir: settings.downloadDir,
      })
      store.apply({batches: [batch], jobs: [], items: [], logs: []})
      void message.success(t('download.scheduled', {title: batch.url}))
      setUrl('')
      setTouched(false)
    } catch (error) {
      void message.error(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
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
                {waiting ? t('download.schedule') : t('download.start')}
              </Button>
            </Form.Item>
          </Col>
        </Row>
      </Form>
      <Typography.Text type="secondary" className="download-hint">
        {waiting
          ? t('download.scheduledHint', {position: waiting})
          : t('download.capacity', {normal: info.maxConcurrency, cpus: info.cpus, long: longAtOnce})}
      </Typography.Text>
    </Card>
  )
}
