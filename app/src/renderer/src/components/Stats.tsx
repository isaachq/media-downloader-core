import {Card, Col, Progress, Row, Statistic} from 'antd'
import type {ReactNode} from 'react'
import {concurrencyCap} from '../../../shared/contract'
import {useApp} from '../context'
import {useT} from '../i18n'
import {useStoreValue} from '../store'

export type MainTab = 'batches' | 'jobs' | 'finished'

/** A stat card that, when it leads somewhere, opens that tab (click or Enter / Space). */
function StatCard({
  onOpen,
  label,
  children,
}: {
  readonly onOpen?: (() => void) | undefined
  readonly label: string
  readonly children: ReactNode
}) {
  return (
    <Card
      size="small"
      hoverable={onOpen !== undefined}
      {...(onOpen && {
        className: 'stat-link',
        role: 'button',
        tabIndex: 0,
        'aria-label': label,
        onClick: onOpen,
        onKeyDown: event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onOpen()
          }
        },
      })}
    >
      {children}
    </Card>
  )
}

/** This session at a glance; the counts come from the store's running tally (O(1) per render). */
export function Stats({
  onOpen,
  onFailed,
}: {
  readonly onOpen?: (tab: MainTab) => void
  /** The Failed card opens the list of failed downloads (to try them again in a new batch). */
  readonly onFailed?: () => void
}) {
  const t = useT()
  const {info, settings} = useApp()
  const cap = concurrencyCap(info, settings)
  // re-renders when a job changes status, not on progress events
  const counts = useStoreValue(store => store.counts)
  const running = counts.downloading + counts.processing + counts.converting + counts.validating + counts.finalizing
  const completed = counts.completed + counts.skipped
  const capacity = Math.round((Math.min(counts.used, cap) / cap) * 100)
  const open = (tab: MainTab) => (onOpen ? () => onOpen(tab) : undefined)

  return (
    <Row gutter={[12, 12]} className="stats">
      <Col xs={12} md={4}>
        <StatCard onOpen={open('jobs')} label={t('stats.running')}>
          <Statistic title={t('stats.running')} value={running} />
        </StatCard>
      </Col>
      <Col xs={12} md={4}>
        <StatCard onOpen={open('jobs')} label={t('stats.queued')}>
          <Statistic title={t('stats.queued')} value={counts.queued} />
        </StatCard>
      </Col>
      <Col xs={12} md={4}>
        <StatCard onOpen={open('finished')} label={t('stats.completed')}>
          <Statistic title={t('stats.completed')} value={completed} styles={{content: {color: 'var(--ok)'}}} />
        </StatCard>
      </Col>
      <Col xs={12} md={4}>
        <StatCard onOpen={onFailed ?? open('jobs')} label={t('stats.failedOpen')}>
          <Statistic
            title={t('stats.failed')}
            value={counts.failed}
            styles={counts.failed ? {content: {color: 'var(--bad)'}} : {}}
          />
        </StatCard>
      </Col>
      <Col xs={24} md={8}>
        <Card size="small">
          <div className="capacity-label">
            {t('stats.capacity')} · {counts.used}/{cap}
          </div>
          <Progress percent={capacity} steps={cap * 2} size="small" aria-label={t('stats.capacity')} />
        </Card>
      </Col>
    </Row>
  )
}
