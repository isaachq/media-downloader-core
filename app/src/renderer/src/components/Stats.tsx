import {Card, Col, Progress, Row, Statistic} from 'antd'
import {useMemo} from 'react'
import {useApp} from '../context'
import {useT} from '../i18n'
import {useStore} from '../store'

export function Stats() {
  const t = useT()
  const {info} = useApp()
  const store = useStore()
  const version = store.version
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when the store changes
  const counts = useMemo(() => {
    let running = 0
    let queued = 0
    let completed = 0
    let failed = 0
    let used = 0
    for (const job of store.jobs.values()) {
      if (job.outcome === 'success') completed++
      else if (job.outcome === 'failed' && job.status !== 'cancelled') failed++
      else if (job.outcome === 'in-progress') {
        if (job.status === 'queued') queued++
        else {
          running++
          used += job.weight
        }
      }
    }
    return {running, queued, completed, failed, used}
  }, [version])
  const capacity = Math.round((Math.min(counts.used, info.maxConcurrency) / info.maxConcurrency) * 100)

  return (
    <Row gutter={[12, 12]} className="stats">
      <Col xs={12} md={4}>
        <Card size="small">
          <Statistic title={t('stats.running')} value={counts.running} />
        </Card>
      </Col>
      <Col xs={12} md={4}>
        <Card size="small">
          <Statistic title={t('stats.queued')} value={counts.queued} />
        </Card>
      </Col>
      <Col xs={12} md={4}>
        <Card size="small">
          <Statistic title={t('stats.completed')} value={counts.completed} valueStyle={{color: 'var(--ok)'}} />
        </Card>
      </Col>
      <Col xs={12} md={4}>
        <Card size="small">
          <Statistic
            title={t('stats.failed')}
            value={counts.failed}
            valueStyle={counts.failed ? {color: 'var(--bad)'} : {}}
          />
        </Card>
      </Col>
      <Col xs={24} md={8}>
        <Card size="small">
          <div className="capacity-label">
            {t('stats.capacity')} · {counts.used}/{info.maxConcurrency}
          </div>
          <Progress percent={capacity} steps={info.maxConcurrency * 2} size="small" aria-label={t('stats.capacity')} />
        </Card>
      </Col>
    </Row>
  )
}
