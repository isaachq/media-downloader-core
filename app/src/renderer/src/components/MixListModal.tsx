import {
  CheckCircleOutlined,
  CloseOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
  InfoCircleOutlined,
  PlusOutlined,
  ScheduleOutlined,
  SearchOutlined,
  SnippetsOutlined,
} from '@ant-design/icons'
import {
  Alert,
  App as AntApp,
  Button,
  Collapse,
  Input,
  Modal,
  Progress,
  Select,
  Space,
  Tag,
  Tooltip,
  Typography,
} from 'antd'
import type {BatchSnapshot, MixProgress, MixSkipped} from 'media-downloader-core'
import {type ClipboardEvent, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {
  AUDIO_FORMATS,
  type Format,
  isAudioFormat,
  type LinkSite,
  type MixPreview,
  type MixPreviewItem,
  planMix,
  QUALITIES,
  type Quality,
  VIDEO_FORMATS,
} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {clock, errorText} from '../format'
import {type MessageKey, type Translate, useT} from '../i18n'
import type {SiteLabel} from '../site'
import {Rows} from './Rows'
import {SiteTag} from './SiteTag'

type Stage = {readonly kind: 'edit'} | {readonly kind: 'checking'; readonly progress?: MixProgress | undefined}

/** One link of the list being put together. */
export type MixEntry = {readonly url: string; readonly site: SiteLabel; readonly key: string}

/** A format: the list's, or a link's own. */
type Choice = {readonly format: Format; readonly quality: Quality}

/** A link straight to a media file of any other site is a file; a named site stays itself. */
const labelOf = (site: SiteLabel, url: string): SiteLabel =>
  site === 'web' && /\.(mp4|m4v|mov|webm|mkv|m4a|mp3|opus|ogg|oga|flac|wav|aac)(?:[?#]|$)/i.test(url) ? 'file' : site

/** A link without its scheme and "www.", for a card: the part that tells links apart. */
const shortUrl = (url: string): string => url.replace(/^https?:\/\/(www\.)?/i, '')

/**
 * The list with the links of `text` added at its end: each new one once (by the
 * core's `linkKey`, the engine's own notion of the same link). `found`: links the
 * text held (repeats included), `added`: how many were new. O(n + m) with a Set.
 * Every site goes in on the desktop: YouTube and other pages are read by yt-dlp.
 */
export function addLinks(
  entries: readonly MixEntry[],
  text: string,
  /** More hosts for a site: the local fakes of the end-to-end runs. */
  aliases?: Readonly<Record<string, LinkSite>> | undefined,
): {readonly entries: readonly MixEntry[]; readonly added: number; readonly found: number} {
  const plan = planMix(text, {aliases})
  const known = new Set(entries.map(entry => entry.key))
  const next = [...entries]
  for (const link of plan.links) {
    if (known.has(link.key)) continue
    known.add(link.key)
    next.push({url: link.url, site: labelOf(link.site, link.url), key: link.key})
  }
  const repeats = plan.skipped.filter(skip => skip.reason === 'duplicate').length
  return {entries: next, added: next.length - entries.length, found: plan.links.length + repeats}
}

/** "Video · MP4 · Best available", "Audio · MP3 · Best audio". */
export function formatSummary(t: Translate, {format, quality}: Choice): string {
  const audio = isAudioFormat(format)
  return t('mix.formatSummary', {
    type: audio ? t('download.audio') : t('download.video'),
    format: format.toUpperCase(),
    quality: audio ? t('download.qualityAudio') : quality === 'best' ? t('quality.best') : `${quality}p`,
  })
}

/** The formats a link can take by itself: each video container at its best (MP4 at three caps too), each audio one. */
const OWN_CHOICES: readonly Choice[] = [
  ...VIDEO_FORMATS.map(format => ({format, quality: 'best' as const})),
  ...(['1080', '720', '480'] as const).map(quality => ({format: 'mp4' as const, quality})),
  ...AUDIO_FORMATS.map(format => ({format, quality: 'best' as const})),
]
const choiceKey = (choice: Choice): string => `${choice.format}:${choice.quality}`

/** Links by site, in the order the sites first appear. O(n). */
function countSites(sites: readonly SiteLabel[]): Array<[SiteLabel, number]> {
  const counts = new Map<SiteLabel, number>()
  for (const site of sites) counts.set(site, (counts.get(site) ?? 0) + 1)
  return [...counts]
}

/**
 * A mix list: links of any sites gathered together become one batch — the
 * same page as the Android app's. Links go in one by one (type or paste one,
 * Add) or a whole list at once (Paste list, or a paste of several links), each
 * a numbered card with its site. The format is said and chosen here, for all
 * links; Check asks the engine to check them all at once; the preview groups
 * what downloads by site, lets any link take a format of its own, and says
 * what was left out and why; one click schedules them all as a single batch.
 */
export function MixListModal({
  text: initial,
  check: checkAtOnce,
  onScheduled,
  onClose,
}: {
  /** The pasted or dropped text ('' from the button). */
  readonly text: string
  /** Check it as soon as it opens (it came from a paste). */
  readonly check: boolean
  readonly onScheduled: (batch: BatchSnapshot) => void
  readonly onClose: () => void
}) {
  const t = useT()
  const {message} = AntApp.useApp()
  const {info, settings} = useApp()
  const [entries, setEntries] = useState<readonly MixEntry[]>(() => addLinks([], initial, info.siteAliases).entries)
  const [draft, setDraft] = useState('')
  /** What the last add did, under the field: "Added: 3", "Already in the list", "That is not a link". */
  const [note, setNote] = useState<{readonly text: string; readonly error: boolean} | undefined>()
  const [stage, setStage] = useState<Stage>({kind: 'edit'})
  const [preview, setPreview] = useState<MixPreview | undefined>()
  /** Links taken out of the preview. */
  const [removed, setRemoved] = useState<ReadonlySet<string>>(new Set())
  /** What every link becomes (the form's choice to start with). */
  const [all, setAll] = useState<Choice>({format: settings.format, quality: settings.quality})
  /** Links in a format of their own, by url. */
  const [own, setOwn] = useState<Readonly<Record<string, Choice>>>({})
  const [infoOpen, setInfoOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // set when the user stops the check: its rejection is not an error to show
  const stopped = useRef(false)

  const sites = useMemo(() => countSites(entries.map(entry => entry.site)), [entries])

  useEffect(
    () =>
      api().onMixProgress(progress =>
        setStage(current => (current.kind === 'checking' ? {kind: 'checking', progress} : current)),
      ),
    [],
  )

  /** Add what a text holds (one link, or a whole list), and say what happened. */
  const add = (text: string) => {
    if (!text.trim()) return
    const result = addLinks(entries, text, info.siteAliases)
    if (result.found === 0) {
      setNote({text: t('mix.notLink'), error: true})
      return
    }
    setEntries(result.entries)
    setDraft('')
    setNote(
      result.added > 0
        ? {text: t('mix.added', {count: result.added}), error: false}
        : {text: t('mix.already'), error: true},
    )
  }

  const pasteList = async () => add((await navigator.clipboard?.readText().catch(() => '')) ?? '')

  const check = useCallback(
    async (list: readonly MixEntry[]) => {
      if (list.length === 0) return
      stopped.current = false
      setNote(undefined)
      setStage({kind: 'checking'})
      try {
        // one link per line: the preview's line numbers are the cards' numbers
        const result = await api().analyzeMix(list.map(entry => entry.url).join('\n'), all.format, all.quality)
        setPreview(result)
        setRemoved(new Set())
      } catch (error) {
        if (!stopped.current) void message.error(errorText(error))
      } finally {
        setStage({kind: 'edit'})
      }
    },
    [all, message],
  )

  // from a paste: checked at once (once, even in React's double-run dev mode)
  const started = useRef(false)
  // biome-ignore lint/correctness/useExhaustiveDependencies: only when it opens
  useEffect(() => {
    if (!checkAtOnce || started.current) return
    started.current = true
    void check(entries)
  }, [])

  const kept = preview ? preview.valid.filter(item => !removed.has(item.url)) : []
  // what downloads, by site: one group per site, in the order the sites first appear. O(n)
  const groups = useMemo(() => {
    const bySite = new Map<SiteLabel, MixPreviewItem[]>()
    for (const item of kept) {
      const site = labelOf(item.site, item.url)
      const list = bySite.get(site)
      if (list) list.push(item)
      else bySite.set(site, [item])
    }
    return [...bySite]
  }, [kept])

  const choose = (url: string, choice: Choice | undefined) =>
    setOwn(current => {
      const next = {...current}
      // the list's own format is no format of its own
      if (choice && choiceKey(choice) !== choiceKey(all)) next[url] = choice
      else delete next[url]
      return next
    })

  const schedule = async () => {
    if (!preview || kept.length === 0) return
    setBusy(true)
    try {
      const batch = await api().scheduleMix({
        id: preview.id,
        urls: kept.map(item => item.url),
        format: all.format,
        quality: all.quality,
        outDir: settings.downloadDir,
        formats: Object.fromEntries(kept.filter(item => own[item.url]).map(item => [item.url, own[item.url]!])),
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

  const formatAll = <FormatAll value={all} onChange={setAll} disabled={checking || busy} />

  const footer = preview
    ? [
        <Tooltip key="edit" title={t('mix.edit')}>
          <Button
            icon={<EditOutlined />}
            onClick={() => setPreview(undefined)}
            aria-label={t('mix.edit')}
            data-testid="mix-edit"
          />
        </Tooltip>,
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
          disabled={entries.length === 0}
          onClick={() => void check(entries)}
          data-testid="mix-check"
        >
          {t('mix.check', {count: entries.length})}
        </Button>,
      ]

  return (
    <Modal
      open
      title={
        // what a mix list is: one click away (info), not spelled out on the form
        <span className="mix-title">
          <Button
            type="text"
            size="small"
            icon={<InfoCircleOutlined />}
            onClick={() => setInfoOpen(true)}
            aria-label={t('mix.heroTitle')}
            data-testid="mix-info"
          />
          {t('mix.title')}
        </span>
      }
      onCancel={cancel}
      mask={{closable: false}}
      width={780}
      footer={footer}
      className="mix-modal"
    >
      {/* mounted only while open: closed, it leaves nothing behind */}
      {infoOpen ? (
        <Modal
          open
          title={t('mix.heroTitle')}
          width={420}
          onCancel={() => setInfoOpen(false)}
          footer={<Button onClick={() => setInfoOpen(false)}>{t('common.close')}</Button>}
        >
          <Typography.Paragraph style={{marginBottom: 0}}>{t('mix.hint')}</Typography.Paragraph>
        </Modal>
      ) : null}
      {preview ? (
        <>
          {formatAll}
          <div className="mix-summary" data-testid="mix-summary">
            <Tag color="success">{t('mix.ready', {count: kept.length})}</Tag>
            {preview.summary.skipped > 0 ? (
              <Tag color="warning">{t('mix.leftOut', {count: preview.summary.skipped})}</Tag>
            ) : null}
          </div>
          {kept.length === 0 ? <Alert type="warning" showIcon title={t('mix.nothing')} /> : null}
          <div className="mix-groups">
            {groups.map(([site, items]) => (
              <section key={site} className="mix-group" data-testid={`mix-group-${site}`}>
                <div className="mix-group-head">
                  <SiteTag site={site} /> <Typography.Text type="secondary">{items.length}</Typography.Text>
                </div>
                <Rows
                  className="many-list mix-list"
                  items={items}
                  rowKey={item => item.url}
                  render={item => (
                    <ValidRow
                      item={item}
                      all={all}
                      own={own[item.url]}
                      onChoose={choice => choose(item.url, choice)}
                      onRemove={() => setRemoved(new Set(removed).add(item.url))}
                    />
                  )}
                />
              </section>
            ))}
          </div>
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
      ) : (
        <>
          <div className="mix-form" data-testid="mix-form">
            <Space.Compact block>
              <Input
                size="large"
                value={draft}
                placeholder={t('mix.inputLabel')}
                aria-label={t('mix.inputLabel')}
                disabled={checking}
                status={note?.error ? 'error' : ''}
                onChange={event => {
                  setNote(undefined)
                  setDraft(event.target.value)
                }}
                onPressEnter={() => add(draft)}
                // a paste with several links goes in whole: no need to press Add
                onPaste={(event: ClipboardEvent<HTMLInputElement>) => {
                  const pasted = event.clipboardData.getData('text')
                  if (planMix(pasted, {aliases: info.siteAliases, maxLinks: 2}).links.length < 2) return
                  event.preventDefault()
                  add(pasted)
                }}
                data-testid="mix-input"
              />
              <Button
                size="large"
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => add(draft)}
                disabled={checking}
                data-testid="mix-add"
              >
                {t('mix.add')}
              </Button>
            </Space.Compact>
            {note ? (
              <div className={note.error ? 'mix-note mix-note-error' : 'mix-note'} data-testid="mix-note" role="status">
                {note.error ? <ExclamationCircleOutlined /> : <CheckCircleOutlined />}
                <span>{note.text}</span>
              </div>
            ) : null}
            <Space wrap>
              <Button
                icon={<SnippetsOutlined />}
                onClick={() => void pasteList()}
                disabled={checking}
                data-testid="mix-paste-list"
              >
                {t('mix.pasteList')}
              </Button>
              {entries.length > 0 ? (
                <Button
                  type="text"
                  icon={<DeleteOutlined />}
                  onClick={() => {
                    setEntries([])
                    setNote(undefined)
                  }}
                  disabled={checking}
                  data-testid="mix-clear"
                >
                  {t('mix.clear')}
                </Button>
              ) : null}
            </Space>
          </div>
          {formatAll}
          {entries.length > 0 ? (
            <div className="mix-sites" data-testid="mix-sites">
              <Typography.Text strong>{t('mix.found', {count: entries.length})}</Typography.Text>
              {sites.map(([site, count]) => (
                <span key={site} className="mix-site-count">
                  <SiteTag site={site} /> {count}
                </span>
              ))}
            </div>
          ) : null}
          <Rows
            className="many-list mix-list"
            items={entries}
            rowKey={entry => entry.key}
            empty={t('mix.empty')}
            render={(entry, index) => (
              <>
                <Typography.Text type="secondary" className="mix-line">
                  {index + 1}
                </Typography.Text>
                <SiteTag site={entry.site} className="many-site" />
                <Typography.Text className="one-line mono" title={entry.url}>
                  {shortUrl(entry.url)}
                </Typography.Text>
                <Button
                  size="small"
                  type="text"
                  icon={<CloseOutlined />}
                  aria-label={t('mix.remove')}
                  disabled={checking}
                  onClick={() => setEntries(entries.filter(other => other.key !== entry.key))}
                />
              </>
            )}
          />
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

/** The format every link becomes: the form's own selects (video / audio, container, quality). */
function FormatAll({
  value,
  onChange,
  disabled,
}: {
  readonly value: Choice
  readonly onChange: (choice: Choice) => void
  readonly disabled: boolean
}) {
  const t = useT()
  const audio = isAudioFormat(value.format)
  return (
    <div className="mix-format" data-testid="mix-format">
      <Typography.Text type="secondary" className="mix-format-label">
        {t('mix.formatAll')}
      </Typography.Text>
      <Select
        aria-label={t('download.format')}
        value={value.format}
        disabled={disabled}
        className="mix-format-select"
        options={[
          {
            label: t('download.video'),
            options: VIDEO_FORMATS.map(f => ({value: f, label: t(`format.${f}` as MessageKey)})),
          },
          {
            label: t('download.audio'),
            options: AUDIO_FORMATS.map(f => ({value: f, label: t(`format.${f}` as MessageKey)})),
          },
        ]}
        onChange={(format: Format) => onChange({format, quality: isAudioFormat(format) ? 'best' : value.quality})}
      />
      <Select
        aria-label={t('download.quality')}
        value={audio ? 'best' : value.quality}
        disabled={disabled || audio}
        className="mix-quality-select"
        options={
          audio
            ? [{value: 'best', label: t('download.qualityAudio')}]
            : QUALITIES.map(q => ({value: q, label: q === 'best' ? t('quality.best') : `${q}p`}))
        }
        onChange={(quality: Quality) => onChange({format: value.format, quality})}
      />
    </div>
  )
}

function ValidRow({
  item,
  all,
  own,
  onChoose,
  onRemove,
}: {
  readonly item: MixPreviewItem
  readonly all: Choice
  readonly own: Choice | undefined
  readonly onChoose: (choice: Choice | undefined) => void
  readonly onRemove: () => void
}) {
  const t = useT()
  return (
    <>
      <div className="mix-row-text">
        <Typography.Text className="one-line" title={item.url}>
          {item.title ?? item.url}
        </Typography.Text>
        <Typography.Text type="secondary" className="one-line mono mix-url">
          {[clock(item.duration), shortUrl(item.url)].filter(Boolean).join(' · ')}
        </Typography.Text>
      </div>
      <Select
        size="small"
        className="mix-item-format"
        popupMatchSelectWidth={false}
        aria-label={t('download.format')}
        value={own ? choiceKey(own) : 'same'}
        options={[
          {value: 'same', label: `${t('mix.formatSame')} · ${formatSummary(t, all)}`},
          ...OWN_CHOICES.map(choice => ({value: choiceKey(choice), label: formatSummary(t, choice)})),
        ]}
        onChange={(value: string) => onChoose(OWN_CHOICES.find(choice => choiceKey(choice) === value))}
        data-testid="mix-item-format"
      />
      {/* checked against the list's format: a link with its own format is not said to be downloaded already */}
      {item.archived && !own ? <Tag>{t('mix.archived')}</Tag> : null}
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
        {shortUrl(item.input)}
      </Typography.Text>
      <Tag color="warning">{reason}</Tag>
    </>
  )
}
