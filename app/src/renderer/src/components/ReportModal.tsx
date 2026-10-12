import {CopyOutlined, FolderOpenOutlined, ReloadOutlined} from '@ant-design/icons'
import {
  App as AntApp,
  Button,
  Card,
  Col,
  Empty,
  Flex,
  List,
  Modal,
  Progress,
  Row,
  Space,
  Statistic,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import {useCallback, useEffect, useState} from 'react'
import {api} from '../api'
import {useApp} from '../context'
import {bytes, moment, rate, timeLeft} from '../format'
import {type MessageKey, useT} from '../i18n'
import {buildReport, type Report, type ReportBatch, reportText, STAGES} from '../report'
import {useAppStore} from '../store'

/** The report is read again this often (and on demand). */
export const REPORT_REFRESH_MS = 15_000

const BATCH_COLOR: Readonly<Record<ReportBatch['status'], string>> = {
  scheduled: 'default',
  checking: 'processing',
  running: 'processing',
  completed: 'success',
  'completed-with-errors': 'warning',
  failed: 'error',
  cancelled: 'warning',
}

/** "next update in 12 s": its own 1 s clock, so the report itself renders once per reading. */
function Countdown({due}: {readonly due: number}) {
  const t = useT()
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  return (
    <span data-testid="report-next">{t('report.next', {seconds: Math.max(0, Math.ceil((due - now) / 1000))})}</span>
  )
}

/**
 * The whole run on one screen — what the Batches, Downloads and Finished tabs
 * hold, summed up: run id, pending / in progress / finished / failed, each
 * pipeline stage with what is in it right now, every batch, recent results.
 * Read from the store every 15 s (not on every event), and copyable as text.
 */
export function ReportModal({open, onClose}: {readonly open: boolean; readonly onClose: () => void}) {
  const t = useT()
  const {info, settings} = useApp()
  const {message} = AntApp.useApp()
  const store = useAppStore()
  const lang = settings.language
  const [report, setReport] = useState<Report | undefined>()
  const [auto, setAuto] = useState(true)

  const take = useCallback(
    () =>
      setReport(
        buildReport({
          runId: info.sessionId,
          startedAt: info.startedAt,
          counts: store.counts,
          batches: store.batches.values(),
          jobs: store.jobs.values(),
        }),
      ),
    [info.sessionId, info.startedAt, store],
  )

  useEffect(() => {
    if (open) take()
  }, [open, take])
  // the next reading 15 s after this one (a manual refresh restarts the wait)
  useEffect(() => {
    if (!open || !auto || !report) return undefined
    const timer = setTimeout(take, REPORT_REFRESH_MS)
    return () => clearTimeout(timer)
  }, [open, auto, report, take])

  const copy = async () => {
    if (!report) return
    const text = reportText(report, {
      label: (key, params) => t(key as MessageKey, params),
      bytes: value => bytes(value, lang),
      rate: value => rate(value, lang) || '0',
      time: ms => moment(ms, lang),
      left: timeLeft,
    })
    await navigator.clipboard?.writeText(text)
    void message.success(t('report.copied'))
  }

  const nothing = report && report.batches.length === 0 && report.inProgress + report.pending + report.finished === 0
  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={1000}
      title={t('report.title')}
      destroyOnHidden
      footer={null}
      className="report-modal"
    >
      {report ? (
        <Space direction="vertical" size="middle" className="full" data-testid="report">
          <Flex justify="space-between" align="center" wrap gap={8}>
            <Space direction="vertical" size={0}>
              <Space wrap>
                <Typography.Text type="secondary">{t('report.runId')}:</Typography.Text>
                <Typography.Text code copyable={{text: report.runId}} data-testid="report-run-id">
                  {report.runId}
                </Typography.Text>
              </Space>
              <Typography.Text type="secondary">
                {t('report.started')}: {moment(report.startedAt, lang)} ·{' '}
                {t('report.updated', {time: moment(report.at, lang)})} ·{' '}
                {auto ? <Countdown key={report.at} due={report.at + REPORT_REFRESH_MS} /> : t('report.paused')}
              </Typography.Text>
            </Space>
            <Space wrap>
              <Space size={6}>
                <Switch size="small" checked={auto} onChange={setAuto} aria-label={t('report.auto')} />
                <Typography.Text>{t('report.auto')}</Typography.Text>
              </Space>
              <Button icon={<ReloadOutlined />} onClick={take}>
                {t('report.refresh')}
              </Button>
              <Button icon={<CopyOutlined />} onClick={() => void copy()}>
                {t('report.copy')}
              </Button>
            </Space>
          </Flex>

          {nothing ? (
            <Empty description={t('report.empty')} />
          ) : (
            <>
              <Row gutter={[12, 12]}>
                {(
                  [
                    [
                      'pending',
                      report.pending,
                      undefined,
                      report.batchesWaiting ? t('report.batchesWaiting', {count: report.batchesWaiting}) : undefined,
                    ],
                    ['inProgress', report.inProgress, 'var(--accent, #13a8e0)', undefined],
                    [
                      'finished',
                      report.finished,
                      'var(--ok)',
                      report.skipped ? t('report.skipped', {count: report.skipped}) : undefined,
                    ],
                    [
                      'failed',
                      report.failed,
                      report.failed ? 'var(--bad)' : undefined,
                      report.cancelled ? t('report.cancelled', {count: report.cancelled}) : undefined,
                    ],
                  ] as const
                ).map(([key, value, color, note]) => (
                  <Col xs={12} md={6} key={key}>
                    <Card size="small" data-testid={`report-${key}`}>
                      <Statistic
                        title={t(`report.${key}` as MessageKey)}
                        value={value}
                        {...(color && {valueStyle: {color}})}
                      />
                      {note ? <Typography.Text type="secondary">{note}</Typography.Text> : null}
                    </Card>
                  </Col>
                ))}
              </Row>

              <Card size="small">
                <Typography.Text strong>{t('report.overall')}</Typography.Text>
                <Progress
                  percent={Math.floor(report.fraction * 100)}
                  status={report.inProgress ? 'active' : 'normal'}
                />
                <Space wrap split="·">
                  <span>
                    {t('report.speed')}: {rate(report.speed, lang) || '—'}
                  </span>
                  <span>
                    {t('report.downloaded')}: {bytes(report.finishedBytes, lang)}
                  </span>
                  {report.inProgress || report.pending ? (
                    <span>
                      {t('report.eta')}:{' '}
                      {report.etaSeconds === undefined ? t('report.etaUnknown') : timeLeft(report.etaSeconds)}
                    </span>
                  ) : null}
                </Space>
                <div className="report-stages">
                  <Typography.Text type="secondary">{t('report.stages')}: </Typography.Text>
                  {STAGES.map(stage => (
                    <Tag
                      key={stage}
                      color={report.stages[stage] ? 'processing' : 'default'}
                      data-testid={`report-stage-${stage}`}
                    >
                      {t(`job.status.${stage}` as MessageKey)} · {report.stages[stage]}
                    </Tag>
                  ))}
                </div>
              </Card>

              <Card size="small" title={t('report.now')}>
                {report.inProgress === 0 ? (
                  <Typography.Text type="secondary">{t('report.idle')}</Typography.Text>
                ) : (
                  <Space direction="vertical" className="full" size={4}>
                    {STAGES.filter(stage => report.now[stage].length > 0).map(stage => (
                      <div key={stage}>
                        <Typography.Text strong>
                          {t(`job.status.${stage}` as MessageKey)} ({report.stages[stage]})
                        </Typography.Text>
                        {report.now[stage].map(job => (
                          <Flex key={job.id} gap={12} align="center" className="report-job">
                            <Typography.Text className="one-line report-job-title" title={job.title}>
                              {job.title}
                            </Typography.Text>
                            <Progress
                              percent={job.fraction === undefined ? 0 : Math.floor(job.fraction * 100)}
                              size="small"
                              status="active"
                              className="report-job-progress"
                            />
                            <Typography.Text type="secondary" className="mono report-job-rate">
                              {job.speed ? rate(job.speed, lang) : ''}
                            </Typography.Text>
                          </Flex>
                        ))}
                        {report.stages[stage] > report.now[stage].length ? (
                          <Typography.Text type="secondary">
                            {t('report.more', {count: report.stages[stage] - report.now[stage].length})}
                          </Typography.Text>
                        ) : null}
                      </div>
                    ))}
                  </Space>
                )}
              </Card>

              {report.batches.length ? (
                <Table<ReportBatch>
                  size="small"
                  rowKey="id"
                  title={() => <Typography.Text strong>{t('report.batches')}</Typography.Text>}
                  dataSource={[...report.batches]}
                  pagination={report.batches.length > 8 ? {pageSize: 8, showSizeChanger: false} : false}
                  columns={[
                    {
                      title: t('report.col.batch'),
                      key: 'batch',
                      ellipsis: true,
                      render: (_, batch) => (
                        <Space direction="vertical" size={0}>
                          <Typography.Text className="one-line" title={batch.title}>
                            {batch.title}
                          </Typography.Text>
                          <Typography.Text type="secondary" className="mono" copyable={{text: batch.id}}>
                            {batch.id}
                          </Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: t('job.status'),
                      key: 'status',
                      width: 170,
                      render: (_, batch) => (
                        <Tag color={BATCH_COLOR[batch.status]}>{t(`batch.status.${batch.status}` as MessageKey)}</Tag>
                      ),
                    },
                    {
                      title: t('report.col.done'),
                      key: 'done',
                      width: 140,
                      render: (_, batch) => (
                        <span>
                          {batch.succeeded}/{batch.total}
                          {batch.failed ? <Typography.Text type="danger"> · {batch.failed}✗</Typography.Text> : null}
                        </span>
                      ),
                    },
                    {
                      title: t('job.progress'),
                      key: 'progress',
                      width: 170,
                      render: (_, batch) => <Progress percent={Math.floor(batch.fraction * 100)} size="small" />,
                    },
                    {
                      title: t('report.eta'),
                      key: 'eta',
                      width: 110,
                      render: (_, batch) => (batch.etaSeconds === undefined ? '' : timeLeft(batch.etaSeconds)),
                    },
                    {
                      title: '',
                      key: 'open',
                      width: 56,
                      render: (_, batch) =>
                        batch.succeeded > 0 ? (
                          <Button
                            size="small"
                            icon={<FolderOpenOutlined />}
                            aria-label={t('report.openFolder')}
                            title={t('report.openFolder')}
                            onClick={() => void api().openFolder({batchId: batch.id})}
                          />
                        ) : null,
                    },
                  ]}
                />
              ) : null}

              <Row gutter={[12, 12]}>
                <Col xs={24} md={12}>
                  <Card size="small" title={t('report.recentDone')}>
                    <List
                      size="small"
                      dataSource={[...report.recentDone]}
                      locale={{emptyText: '—'}}
                      renderItem={job => (
                        <List.Item>
                          <Typography.Text className="one-line" title={job.title}>
                            {job.title}
                          </Typography.Text>
                        </List.Item>
                      )}
                    />
                  </Card>
                </Col>
                <Col xs={24} md={12}>
                  <Card size="small" title={t('report.recentFailed')}>
                    <List
                      size="small"
                      dataSource={[...report.recentFailed]}
                      locale={{emptyText: '—'}}
                      renderItem={job => (
                        <List.Item>
                          <Space direction="vertical" size={0} className="full">
                            <Typography.Text className="one-line" title={job.title}>
                              {job.title}
                            </Typography.Text>
                            <Typography.Text type="danger" className="one-line" title={job.error ?? ''}>
                              {job.error}
                            </Typography.Text>
                          </Space>
                        </List.Item>
                      )}
                    />
                  </Card>
                </Col>
              </Row>
            </>
          )}
        </Space>
      ) : null}
    </Modal>
  )
}
