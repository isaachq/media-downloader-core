import {GithubOutlined, HeartFilled, StarFilled} from '@ant-design/icons'
import {Button, Descriptions, Modal, Space, Typography} from 'antd'
import {api} from '../api'
import {useApp} from '../context'
import {useT} from '../i18n'
import {Rows} from './Rows'
import {useUpdateState} from './UpdateBanner'

/** Where the project lives: source, issues, releases — and its stars. */
const REPO = 'https://github.com/isaachq/media-downloader-core'

const CREDITS: ReadonlyArray<readonly [name: string, license: string, url: string]> = [
  ['Ant Design', 'MIT', 'https://ant.design'],
  ['yt-dlp', 'Unlicense', 'https://github.com/yt-dlp/yt-dlp'],
  ['FFmpeg', 'LGPL / GPL', 'https://ffmpeg.org'],
  ['Electron', 'MIT', 'https://www.electronjs.org'],
  ['React', 'MIT', 'https://react.dev'],
]

export function AboutModal({open, onClose}: {readonly open: boolean; readonly onClose: () => void}) {
  const t = useT()
  const {info} = useApp()
  return (
    <Modal
      open={open}
      title={t('about.title')}
      width={740}
      onCancel={onClose}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <Typography.Title level={4} style={{marginTop: 0, marginBottom: 4}}>
        Media Download Core
      </Typography.Title>
      <Typography.Paragraph type="secondary" style={{marginBottom: 16}}>
        {t('about.description')}
      </Typography.Paragraph>

      <Descriptions size="small" column={{xs: 1, sm: 2, md: 3}} style={{marginBottom: 16}}>
        <Descriptions.Item label="Version">
          <Typography.Text strong>{info.version}</Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label={t('update.label')}>
          <UpdateCheck />
        </Descriptions.Item>
        <Descriptions.Item label="Platform">{`${info.platform} · ${info.cpus} CPUs`}</Descriptions.Item>
        <Descriptions.Item label="Session" span={3}>
          <Typography.Text code copyable>
            {info.sessionId}
          </Typography.Text>
        </Descriptions.Item>
      </Descriptions>

      <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 16}}>
        <div
          style={{
            border: '1px solid var(--ant-color-border-secondary, rgba(5, 5, 5, 0.06))',
            borderRadius: 8,
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <Typography.Paragraph strong style={{marginBottom: 8}}>
              <HeartFilled style={{color: 'var(--bad)'}} /> {t('about.thanks')}
            </Typography.Paragraph>
            <Typography.Paragraph type="secondary" style={{marginBottom: 16}}>
              {t('about.antd')}
            </Typography.Paragraph>
          </div>
          <div className="about-star" data-testid="about-star" style={{margin: 0}}>
            <Typography.Paragraph style={{marginBottom: 8}}>
              <StarFilled className="star" /> {t('about.star')}
            </Typography.Paragraph>
            <Button icon={<GithubOutlined />} href={REPO} target="_blank" block type="primary" ghost>
              {t('about.starButton')}
            </Button>
            <Typography.Paragraph type="secondary" className="about-repo" style={{textAlign: 'center', marginTop: 8}}>
              <Typography.Link href={REPO} target="_blank">
                {REPO.replace('https://', '')}
              </Typography.Link>
            </Typography.Paragraph>
          </div>
        </div>

        <div
          style={{
            border: '1px solid var(--ant-color-border-secondary, rgba(5, 5, 5, 0.06))',
            borderRadius: 8,
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'space-between',
          }}
        >
          <div>
            <Typography.Paragraph strong style={{marginBottom: 8}}>
              {t('about.credits')}
            </Typography.Paragraph>
            <Rows
              items={CREDITS}
              rowKey={([name]) => name}
              render={([name, license, url]) => (
                <>
                  <Typography.Link href={url} target="_blank">
                    {name}
                  </Typography.Link>
                  <Typography.Text type="secondary">{license}</Typography.Text>
                </>
              )}
            />
          </div>
          <Typography.Paragraph type="secondary" style={{margin: '12px 0 0', fontSize: 12}}>
            {t('about.license')}
          </Typography.Paragraph>
        </div>
      </div>
    </Modal>
  )
}

/** "Check for updates" and what came of it. */
function UpdateCheck() {
  const t = useT()
  const state = useUpdateState()
  const open = (page: string) => window.open(page, '_blank', 'noopener')
  switch (state.status) {
    case 'unsupported':
      return <Typography.Link onClick={() => open(state.page)}>{t('update.unsupported')}</Typography.Link>
    case 'checking':
      return <Typography.Text type="secondary">{t('update.checking')}</Typography.Text>
    case 'available':
      return (
        <Space wrap>
          <Typography.Text strong>{t('update.available', {version: state.version})}</Typography.Text>
          <Button size="small" type="primary" onClick={() => void api().installUpdate()}>
            {t('update.install')}
          </Button>
        </Space>
      )
    case 'downloading':
    case 'installing':
    case 'ready':
      return <Typography.Text>{t('update.downloading', {version: state.version})}</Typography.Text>
    default:
      return (
        <Space wrap>
          {state.status === 'up-to-date' ? (
            <Typography.Text type="success">{t('update.upToDate')}</Typography.Text>
          ) : null}
          {state.status === 'error' ? <Typography.Text type="danger">{state.message}</Typography.Text> : null}
          <Button size="small" onClick={() => void api().checkForUpdates()}>
            {t('update.check')}
          </Button>
        </Space>
      )
  }
}
