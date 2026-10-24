import {
  DashboardOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  MoonOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  SunOutlined,
} from '@ant-design/icons'
import {Badge, Button, Segmented, Space, Tooltip, Typography} from 'antd'
import type {ThemeMode} from '../../../shared/contract'
import {useApp} from '../context'
import {rate} from '../format'
import {useT} from '../i18n'
import {useStoreValue} from '../store'
import {Banner} from './Banner'
import {LanguageSelect} from './LanguageSelect'

type Props = {
  readonly onLogs: () => void
  readonly onSettings: () => void
  readonly onAbout: () => void
  readonly onReport: () => void
  readonly onGuide: () => void
}

export function Header({onLogs, onSettings, onAbout, onReport, onGuide}: Props) {
  const t = useT()
  const {settings, updateSettings, dark} = useApp()
  const liveSpeed = useStoreValue(store => store.speed)
  return (
    <Banner dark={dark}>
      <div className="header-row">
        <div>
          <Typography.Title level={2} className="app-title">
            Media Download Core
          </Typography.Title>
          <Typography.Text className="app-tagline">{t('app.tagline')}</Typography.Text>
        </div>
        <Space wrap className="header-actions" align="center">
          {liveSpeed > 0 ? (
            <Tooltip title={t('header.speed', {rate: rate(liveSpeed, settings.language)})}>
              <Badge status="processing" data-testid="header-speed" style={{marginRight: 8, cursor: 'default'}} />
            </Tooltip>
          ) : null}
          <LanguageSelect compact />
          <Segmented
            aria-label={t('header.theme')}
            size="small"
            value={settings.theme}
            options={[
              {
                label: (
                  <Tooltip title={t('theme.light')}>
                    <SunOutlined aria-label={t('theme.light')} />
                  </Tooltip>
                ),
                value: 'light',
              },
              {label: t('theme.system'), value: 'system'},
              {
                label: (
                  <Tooltip title={t('theme.dark')}>
                    <MoonOutlined aria-label={t('theme.dark')} />
                  </Tooltip>
                ),
                value: 'dark',
              },
            ]}
            onChange={value => void updateSettings({theme: value as ThemeMode})}
          />
          <Button icon={<DashboardOutlined />} onClick={onReport} data-testid="open-report">
            {t('header.report')}
          </Button>
          <Button icon={<FileTextOutlined />} onClick={onLogs}>
            {t('header.logs')}
          </Button>
          <Button icon={<SettingOutlined />} onClick={onSettings}>
            {t('header.settings')}
          </Button>
          <Button icon={<QuestionCircleOutlined />} onClick={onGuide} data-testid="open-guide">
            {t('header.guide')}
          </Button>
          <Button icon={<InfoCircleOutlined />} onClick={onAbout} aria-label={t('header.about')} />
        </Space>
      </div>
    </Banner>
  )
}
