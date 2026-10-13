import {
  DashboardOutlined,
  FileTextOutlined,
  InfoCircleOutlined,
  MoonOutlined,
  QuestionCircleOutlined,
  SettingOutlined,
  SunOutlined,
} from '@ant-design/icons'
import {Button, Segmented, Space, Tag, Tooltip, Typography} from 'antd'
import type {ThemeMode} from '../../../shared/contract'
import {useApp} from '../context'
import {useT} from '../i18n'
import {modeName} from '../mode'
import {Banner} from './Banner'

type Props = {
  readonly onLogs: () => void
  readonly onSettings: () => void
  readonly onAbout: () => void
  readonly onReport: () => void
  readonly onGuide: () => void
}

export function Header({onLogs, onSettings, onAbout, onReport, onGuide}: Props) {
  const t = useT()
  const {info, settings, updateSettings, dark} = useApp()
  return (
    <Banner dark={dark}>
      <div className="header-row">
        <div>
          <Typography.Title level={2} className="app-title">
            Media Download Core
          </Typography.Title>
          <Typography.Text className="app-tagline">{t('app.tagline')}</Typography.Text>
          <div>
            <Tooltip title={t('mode.badgeTip')}>
              <Tag
                className="mode-tag"
                role="button"
                tabIndex={0}
                onClick={onSettings}
                onKeyDown={event => {
                  if (event.key === 'Enter' || event.key === ' ') onSettings()
                }}
                data-testid="mode-tag"
                data-mode={info.mode}
              >
                {t('mode.badge', {mode: modeName(t, info.mode)})}
              </Tag>
            </Tooltip>
          </div>
        </div>
        <Space wrap className="header-actions">
          <Segmented
            aria-label={t('header.language')}
            size="small"
            value={settings.language}
            options={[
              {label: 'EN', value: 'en'},
              {label: 'ES', value: 'es'},
            ]}
            onChange={value => void updateSettings({language: value as 'en' | 'es'})}
          />
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
