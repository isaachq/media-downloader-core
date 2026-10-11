import {ReloadOutlined} from '@ant-design/icons'
import {Button, Progress, Result, Typography} from 'antd'
import {BOOT_ATTEMPTS, BOOT_PHASES, type BootProgress} from '../boot'
import type {Translate} from '../i18n'

/**
 * What the window shows while the app starts: the current phase, a bar that
 * advances phase by phase, retries as they happen — and, if a phase still
 * fails, why, with a button that resumes from that phase.
 */
export function BootScreen({
  progress,
  t,
  onRetry,
}: {
  readonly progress: BootProgress
  readonly t: Translate
  readonly onRetry: () => void
}) {
  const index = BOOT_PHASES.indexOf(progress.phase)
  const phaseLabel = t(`boot.${progress.phase}`)

  if (progress.status === 'failed') {
    return (
      <div className="boot-screen" data-testid="boot-screen" data-status="failed">
        <Result
          status="error"
          title={t('boot.failed')}
          subTitle={
            <>
              <Typography.Text strong>{t('boot.failedPhase', {phase: phaseLabel})}</Typography.Text>
              <br />
              <Typography.Text type="secondary" className="mono" data-testid="boot-error">
                {progress.error}
              </Typography.Text>
            </>
          }
          extra={
            <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
              {t('boot.retry')}
            </Button>
          }
        />
      </div>
    )
  }

  // halfway through the current phase: the bar moves as soon as a phase starts
  const percent = Math.round(((index + 0.5) / BOOT_PHASES.length) * 100)
  return (
    <div className="boot-screen" data-testid="boot-screen" data-status="running" data-phase={progress.phase}>
      <Typography.Title level={3}>Media Download Core</Typography.Title>
      <Progress percent={percent} status="active" showInfo={false} className="boot-progress" aria-label={phaseLabel} />
      <Typography.Text>{phaseLabel}</Typography.Text>
      <Typography.Text type="secondary" className="boot-step">
        {progress.attempt > 1
          ? t('boot.retrying', {attempt: progress.attempt, attempts: BOOT_ATTEMPTS})
          : t('boot.step', {current: index + 1, total: BOOT_PHASES.length})}
      </Typography.Text>
    </div>
  )
}
