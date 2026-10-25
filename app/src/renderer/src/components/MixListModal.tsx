import {CloseOutlined, EditOutlined, ScheduleOutlined, SearchOutlined} from '@ant-design/icons'
import {Alert, App as AntApp, Button, Collapse, Input, Modal, Progress, Space, Tag, Typography} from 'antd'
import type {BatchSnapshot, MixProgress, MixSkipped} from 'media-downloader-core'
import {useEffect, useMemo, useRef, useState} from 'react'
import {type MixPreview, type MixPreviewItem, planMix} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {clock, errorText} from '../format'
import {type MessageKey, useT} from '../i18n'
import type {SiteLabel} from '../site'
import {Rows} from './Rows'
import {SiteTag} from './SiteTag'

/** Links, one per line: the same in every language. */
const PLACEHOLDER = ['https://youtu.be/…', 'https://www.tiktok.com/@…/video/…', 'https://x.com/…/status/…'].join('\n')

type Stage = {readonly kind: 'edit'} | {readonly kind: 'checking'; readonly progress?: MixProgress | undefined}

/** A link straight to a media file of any other site is a file; a named site stays itself. */
const labelOf = (site: SiteLabel, url: string): SiteLabel =>
  site === 'web' && /\.(mp4|m4v|mov|webm|mkv|m4a|mp3|opus|ogg|oga|flac|wav|aac)(?:[?#]|$)/i.test(url) ? 'file' : site

/**
 * A mix list: links of any sites pasted together become one batch. Edit the
 * list (each line's site shows as it is typed), check it (the engine checks
 * every link at once), then see what downloads and what is left out — and
 * why — before one click schedules them all as a single batch, in the format,
 * quality and folder chosen in the form.
 */
export function MixListModal({
  text: initial,
  check: checkAtOnce,
  onScheduled,
  onClose,
}: {
  /** The pasted text. */
  readonly text: string
  /** Check it as soon as it opens (it came from a paste, not from the button). */
  readonly check: boolean
  readonly onScheduled: (batch: BatchSnapshot) => void
  readonly onClose: () => void
}) {
  const t = useT()
  const {message} = AntApp.useApp()
  const {info, settings} = useApp()
  const [text, setText] = useState(initial)
  const [stage, setStage] = useState<Stage>({kind: 'edit'})
  const [preview, setPreview] = useState<MixPreview | undefined>()
  /** Links the user took out of the preview. */
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  // set when the user stops the check: its rejection is not an error to show
  const stopped = useRef(false)

  // what the text holds, as the engine will read it: once per change of the text, O(text)
  const plan = useMemo(() => planMix(text, {aliases: info.siteAliases}), [text, info.siteAliases])
  const sites = useMemo(() => countSites(plan.links.map(link => labelOf(link.site, link.url))), [plan])

  useEffect(
    () =>
      api().onMixProgress(progress =>
        setStage(current => (current.kind === 'checking' ? {kind: 'checking', progress} : current)),
      ),
    [],
  )

  const check = async () => {
    if (plan.links.length === 0) return
    stopped.current = false
    setStage({kind: 'checking'})
    try {
      const result = await api().analyzeMix(text, settings.format, settings.quality)
      setPreview(result)
      setRemoved(new Set())
    } catch (error) {
      if (!stopped.current) void message.error(errorText(error))
    } finally {
      setStage({kind: 'edit'})
    }
  }

  // from a paste: checked at once (once, even in React's double-run dev mode)
  const started = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when it opens
  useEffect(() => {
    if (!checkAtOnce || started.current) return
    started.current = true
    void check()
  }, [])

  const kept = preview ? preview.valid.filter(item => !removed.has(item.url)) : []

  const schedule = async () => {
    if (!preview || kept.length === 0) return
    setBusy(true)
    try {
      const batch = await api().scheduleMix({
        id: preview.id,
        urls: kept.map(item => item.url),
        format: settings.format,
        quality: settings.quality,
        outDir: settings.downloadDir,
      })
      onScheduled(batch)
      void message.success(t('mix.scheduled', {count: kept.length}))
      onClose()
    } catch (error) {
      void message.error(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  const cancel = () => {
    if (stage.kind === 'checking') {
      stopped.current = true
      void api().cancelMix()
    }
    onClose()
  }

  const checking = stage.kind === 'checking'
  const progress = checking ? stage.progress : undefined
  const footer = preview
    ? [
        <Button key="edit" icon={<EditOutlined />} onClick={() => setPreview(undefined)} data-testid="mix-edit">
          {t('mix.edit')}
        </Button>,
        <Button key="cancel" onClick={cancel}>
          {t('preview.cancel')}
        </Button>,
        <Button
          key="go"
          type="primary"
          icon={<ScheduleOutlined />}
          loading={busy}
          disabled={kept.length === 0}
          onClick={() => void schedule()}
          data-testid="mix-schedule"
        >
          {t('mix.schedule', {count: kept.length})}
        </Button>,
      ]
    : [
        <Button key="cancel" onClick={cancel}>
          {t('preview.cancel')}
        </Button>,
        <Button
          key="check"
          type="primary"
          icon={<SearchOutlined />}
          loading={checking}
          disabled={plan.links.length === 0}
          onClick={() => void check()}
          data-testid="mix-check"
        >
          {t('mix.check', {count: plan.links.length})}
        </Button>,
      ]

  return (
    <Modal
      open
      title={t('mix.title')}
      onCancel={cancel}
      mask={{closable: false}}
      width={780}
      footer={footer}
      className="mix-modal"
    >
      {preview ? (
        <MixResult
          preview={preview}
          kept={kept.length}
          removed={removed}
          onRemove={url => setRemoved(new Set(removed).add(url))}
        />
      ) : (
        <>
          <Typography.Paragraph type="secondary">{t('mix.hint')}</Typography.Paragraph>
          <Input.TextArea
            value={text}
            onChange={event => setText(event.target.value)}
            autoSize={{minRows: 6, maxRows: 14}}
            disabled={checking}
            placeholder={PLACEHOLDER}
            aria-label={t('mix.field')}
            className="mono"
            data-testid="mix-text"
          />
          <div className="mix-sites" data-testid="mix-sites">
            <Typography.Text type="secondary">{t('mix.found', {count: plan.links.length})}</Typography.Text>
            {sites.map(([site, count]) => (
              <span key={site} className="mix-site-count">
                <SiteTag site={site} /> {count}
              </span>
            ))}
            {plan.skipped.length > 0 ? (
              <Typography.Text type="secondary">{t('mix.leftOutNow', {count: plan.skipped.length})}</Typography.Text>
            ) : null}
          </div>
          {checking ? (
            <div className="mix-progress" data-testid="mix-progress">
              <Progress
                percent={progress?.total ? Math.round((progress.checked / progress.total) * 100) : 0}
                status="active"
                showInfo={false}
              />
              <Typography.Text type="secondary">
                {progress ? t('mix.checking', {checked: progress.checked, total: progress.total}) : t('mix.starting')}
              </Typography.Text>
            </div>
          ) : null}
        </>
      )}
    </Modal>
  )
}

/** What the check found: a summary, the links that download (any can be removed), what was left out and why. */
function MixResult({
  preview,
  kept,
  removed,
  onRemove,
}: {
  readonly preview: MixPreview
  readonly kept: number
  readonly removed: ReadonlySet<string>
  readonly onRemove: (url: string) => void
}) {
  const t = useT()
  const {summary} = preview
  const rows = preview.valid.filter(item => !removed.has(item.url))
  const sites = countSites(rows.map(item => labelOf(item.site, item.url)))
  return (
    <>
      <div className="mix-summary" data-testid="mix-summary">
        <Tag color="success">{t('mix.ready', {count: kept})}</Tag>
        {summary.skipped > 0 ? <Tag color="warning">{t('mix.leftOut', {count: summary.skipped})}</Tag> : null}
        {sites.map(([site, count]) => (
          <span key={site} className="mix-site-count">
            <SiteTag site={site} /> {count}
          </span>
        ))}
      </div>
      {kept === 0 ? <Alert type="warning" showIcon title={t('mix.nothing')} /> : null}
      <Rows
        className="many-list mix-list"
        items={rows}
        rowKey={item => item.url}
        render={item => <ValidRow item={item} onRemove={() => onRemove(item.url)} />}
      />
      {preview.skipped.length > 0 ? (
        <Collapse
          size="small"
          className="mix-skipped"
          items={[
            {
              key: 'skipped',
              label: t('mix.leftOutTitle', {count: preview.skipped.length}),
              children: (
                <Rows
                  className="many-list mix-list"
                  items={preview.skipped}
                  rowKey={item => `${item.line}:${item.input}`}
                  render={item => <SkippedRow item={item} />}
                />
              ),
            },
          ]}
        />
      ) : null}
    </>
  )
}

function ValidRow({item, onRemove}: {readonly item: MixPreviewItem; readonly onRemove: () => void}) {
  const t = useT()
  return (
    <>
      <SiteTag site={labelOf(item.site, item.url)} className="many-site" />
      <div className="mix-row-text">
        <Typography.Text className="one-line" title={item.url}>
          {item.title ?? item.url}
        </Typography.Text>
        <Typography.Text type="secondary" className="one-line mono mix-url">
          {item.url}
        </Typography.Text>
      </div>
      {item.duration ? <Typography.Text type="secondary">{clock(item.duration)}</Typography.Text> : null}
      {item.archived ? <Tag>{t('mix.archived')}</Tag> : null}
      {item.unchecked ? <Tag color="gold">{t('mix.unchecked')}</Tag> : null}
      <Button size="small" type="text" icon={<CloseOutlined />} aria-label={t('mix.remove')} onClick={onRemove} />
    </>
  )
}

function SkippedRow({item}: {readonly item: MixSkipped}) {
  const t = useT()
  const reason =
    item.reason === 'duplicate' && item.duplicateOf !== undefined
      ? t('mix.reason.duplicateOf', {line: item.duplicateOf})
      : t(`mix.reason.${item.reason}` as MessageKey)
  return (
    <>
      <Typography.Text type="secondary" className="mix-line">
        {item.line}
      </Typography.Text>
      <Typography.Text className="one-line mono" title={item.input}>
        {item.input}
      </Typography.Text>
      <Space size={4}>
        <Tag color="warning">{reason}</Tag>
      </Space>
    </>
  )
}

/** Links by site, in the order the sites first appear. O(n). */
function countSites(sites: readonly SiteLabel[]): Array<[SiteLabel, number]> {
  const counts = new Map<SiteLabel, number>()
  for (const site of sites) counts.set(site, (counts.get(site) ?? 0) + 1)
  return [...counts]
}
