import {
  CheckCircleFilled,
  CloseCircleFilled,
  LoadingOutlined,
  SafetyCertificateOutlined,
  WarningOutlined,
} from '@ant-design/icons'
import {Descriptions, Popover, Space, Tag, Tooltip, Typography} from 'antd'
import type {JobSnapshot, JobStep, StepState} from 'media-downloader-core'
import {useApp} from '../context'
import {bytes, clock} from '../format'
import {type MessageKey, useT} from '../i18n'

const STEP_LETTER = {download: 'D', convert: 'C', validate: 'V', finalize: 'F'} as const
const STEP_COLOR: Readonly<Record<StepState, string>> = {
  pending: 'default',
  'in-progress': 'processing',
  success: 'success',
  failed: 'error',
  skipped: 'default',
}

/** The four sub-tasks as compact tags: D C V F, colored by state, explained on hover. */
export function StepTrack({steps}: {readonly steps: readonly JobStep[]}) {
  const t = useT()
  return (
    <Space size={2} className="step-track">
      {steps.map(step => (
        <Tooltip
          key={step.name}
          title={`${t(`step.${step.name}` as MessageKey)}: ${t(`step.state.${step.state}` as MessageKey)}${step.error ? ` — ${step.error.message}` : ''}`}
        >
          <Tag
            color={STEP_COLOR[step.state]}
            className={`step step-${step.state}`}
            data-testid={`step-${step.name}`}
            data-state={step.state}
          >
            {STEP_LETTER[step.name]}
          </Tag>
        </Tooltip>
      ))}
    </Space>
  )
}

/**
 * The integrity verdict of a file, with the full report on click: what was
 * checked, codecs, duration decoded vs expected, size and SHA-256.
 */
export function IntegrityTag({job}: {readonly job: JobSnapshot}) {
  const t = useT()
  const {settings} = useApp()
  const report = job.validation
  const validateStep = job.steps.find(step => step.name === 'validate')
  if (!report) {
    if (validateStep?.state === 'in-progress') {
      return (
        <Tag icon={<LoadingOutlined />} color="processing">
          {t('job.status.validating')}
        </Tag>
      )
    }
    return <Tag>{t('integrity.pending')}</Tag>
  }

  const content = (
    <Descriptions size="small" column={1} className="integrity-report" data-testid="integrity-report">
      <Descriptions.Item label={t('integrity.level')}>
        {t(`integrity.level.${report.level}` as MessageKey)}
      </Descriptions.Item>
      <Descriptions.Item label={t('integrity.container')}>{report.container}</Descriptions.Item>
      {report.video ? (
        <Descriptions.Item label={t('integrity.video')}>
          {report.video.codec} · {report.video.width}×{report.video.height}
          {report.video.fps ? ` · ${report.video.fps} fps` : ''}
        </Descriptions.Item>
      ) : null}
      {report.audio ? (
        <Descriptions.Item label={t('integrity.audio')}>
          {report.audio.codec}
          {report.audio.channels ? ` · ${report.audio.channels} ch` : ''}
          {report.audio.sampleRate ? ` · ${report.audio.sampleRate} Hz` : ''}
        </Descriptions.Item>
      ) : null}
      <Descriptions.Item label={t('integrity.duration')}>
        {clock(report.duration)}
        {report.decodedDuration !== undefined
          ? ` (${t('integrity.decoded', {decoded: clock(report.decodedDuration), expected: clock(report.expectedDuration ?? report.duration)})})`
          : ''}
      </Descriptions.Item>
      <Descriptions.Item label={t('integrity.size')}>{bytes(report.sizeBytes, settings.language)}</Descriptions.Item>
      {report.sha256 ? (
        <Descriptions.Item label={t('integrity.sha256')}>
          <Typography.Text code copyable={{text: report.sha256}} className="sha">
            {report.sha256.slice(0, 16)}…
          </Typography.Text>
        </Descriptions.Item>
      ) : null}
      {report.issues.length ? (
        <Descriptions.Item label={t('integrity.issues')}>
          <ul className="issues">
            {report.issues.map(issue => (
              <li key={issue.code}>{issue.message}</li>
            ))}
          </ul>
        </Descriptions.Item>
      ) : null}
    </Descriptions>
  )

  const verified = report.ok && report.level !== 'none'
  return (
    <Popover title={t('integrity.title')} content={content} trigger="click">
      <Tag
        role="button"
        tabIndex={0}
        className="integrity-tag"
        data-testid="integrity-tag"
        color={report.ok ? (verified ? 'success' : 'default') : 'error'}
        icon={report.ok ? verified ? <SafetyCertificateOutlined /> : <WarningOutlined /> : <CloseCircleFilled />}
      >
        {report.ok ? (verified ? t('integrity.verified') : t('integrity.level.none')) : t('integrity.failed')}
      </Tag>
    </Popover>
  )
}

export function StatusTag({job}: {readonly job: JobSnapshot}) {
  const t = useT()
  const colors: Record<string, string> = {
    completed: 'success',
    skipped: 'cyan',
    failed: 'error',
    cancelled: 'warning',
    queued: 'default',
  }
  const icon =
    job.status === 'completed' ? (
      <CheckCircleFilled />
    ) : job.outcome === 'in-progress' && job.status !== 'queued' ? (
      <LoadingOutlined />
    ) : undefined
  return (
    <Tag color={colors[job.status] ?? 'processing'} icon={icon} data-testid="job-status" data-status={job.status}>
      {t(`job.status.${job.status}` as MessageKey)}
    </Tag>
  )
}
