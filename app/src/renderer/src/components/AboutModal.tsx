import {HeartFilled} from '@ant-design/icons'
import {Button, Descriptions, List, Modal, Typography} from 'antd'
import {useApp} from '../context'
import {useT} from '../i18n'

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
      onCancel={onClose}
      footer={<Button onClick={onClose}>{t('common.close')}</Button>}
    >
      <Typography.Title level={4}>Media Download Core</Typography.Title>
      <Typography.Paragraph>{t('about.description')}</Typography.Paragraph>
      <Descriptions size="small" column={1}>
        <Descriptions.Item label="Version">{info.version}</Descriptions.Item>
        <Descriptions.Item label="Platform">{`${info.platform} · ${info.cpus} CPUs`}</Descriptions.Item>
        <Descriptions.Item label="Session">
          <Typography.Text code copyable>
            {info.sessionId}
          </Typography.Text>
        </Descriptions.Item>
      </Descriptions>
      <Typography.Paragraph strong>
        <HeartFilled style={{color: 'var(--bad)'}} /> {t('about.thanks')}
      </Typography.Paragraph>
      <Typography.Paragraph>{t('about.antd')}</Typography.Paragraph>
      <List
        size="small"
        dataSource={[...CREDITS]}
        renderItem={([name, license, url]) => (
          <List.Item>
            <Typography.Link href={url} target="_blank">
              {name}
            </Typography.Link>
            <Typography.Text type="secondary">{license}</Typography.Text>
          </List.Item>
        )}
      />
      <Typography.Paragraph type="secondary">{t('about.license')}</Typography.Paragraph>
    </Modal>
  )
}
