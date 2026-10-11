import {FolderOpenOutlined, MedicineBoxOutlined, ToolOutlined} from '@ant-design/icons'
import {
  Alert,
  Button,
  Divider,
  Drawer,
  Form,
  Input,
  InputNumber,
  Radio,
  Segmented,
  Select,
  Slider,
  Space,
  Switch,
} from 'antd'
import type {ValidationLevel} from 'media-downloader-core'
import {useState} from 'react'
import {type AppSettings, RESTART_SETTINGS, type ThemeMode} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {useT} from '../i18n'

const BROWSERS = ['chrome', 'chromium', 'edge', 'firefox', 'safari', 'brave', 'opera', 'vivaldi']

type Props = {
  readonly open: boolean
  readonly onClose: () => void
  readonly onDoctor: () => void
  readonly onReinstall: () => void
}

export function SettingsDrawer({open, onClose, onDoctor, onReinstall}: Props) {
  const t = useT()
  const {info, settings, updateSettings} = useApp()
  const [restartNeeded, setRestartNeeded] = useState(false)

  const change = (patch: Partial<AppSettings>) => {
    if (Object.keys(patch).some(key => RESTART_SETTINGS.includes(key as keyof AppSettings))) setRestartNeeded(true)
    void updateSettings(patch)
  }
  const chooseFolder = async () => {
    const folder = await api().chooseFolder(settings.downloadDir)
    if (folder) change({downloadDir: folder})
  }

  return (
    <Drawer title={t('settings.title')} open={open} onClose={onClose} width={480} destroyOnHidden>
      {restartNeeded ? <Alert type="info" showIcon message={t('settings.restart')} className="restart-alert" /> : null}
      <Form layout="vertical">
        <Divider titlePlacement="start">{t('settings.downloads')}</Divider>
        <Form.Item label={t('settings.folder')}>
          <Space.Compact block>
            <Input readOnly value={settings.downloadDir} aria-label={t('settings.folder')} />
            <Button icon={<FolderOpenOutlined />} onClick={() => void chooseFolder()} />
          </Space.Compact>
        </Form.Item>
        <Form.Item
          label={`${t('settings.threads')}: ${settings.concurrency}`}
          extra={t('settings.threadsHelp', {max: info.maxConcurrency, cpus: info.cpus})}
        >
          <Slider
            aria-label={t('settings.threads')}
            min={1}
            max={info.maxConcurrency}
            value={settings.concurrency}
            marks={{1: '1', [info.maxConcurrency]: String(info.maxConcurrency)}}
            onChange={value => change({concurrency: value})}
          />
        </Form.Item>
        <Form.Item label={t('settings.validation')}>
          <Radio.Group
            value={settings.validation}
            onChange={event => change({validation: event.target.value as ValidationLevel})}
          >
            <Space direction="vertical">
              <Radio value="full">{t('settings.validation.full')}</Radio>
              <Radio value="quick">{t('settings.validation.quick')}</Radio>
              <Radio value="none">{t('settings.validation.none')}</Radio>
            </Space>
          </Radio.Group>
        </Form.Item>
        <Form.Item label={t('settings.longVideo')}>
          <InputNumber
            min={5}
            max={600}
            value={settings.longVideoMinutes}
            onChange={value => value && change({longVideoMinutes: value})}
            aria-label={t('settings.longVideo')}
          />
        </Form.Item>
        <Form.Item label={t('settings.cookies')} extra={t('settings.cookiesHelp')}>
          <Select
            aria-label={t('settings.cookies')}
            value={settings.cookiesFromBrowser}
            onChange={(value: string) => change({cookiesFromBrowser: value})}
            options={[{value: '', label: t('settings.cookies.none')}, ...BROWSERS.map(b => ({value: b, label: b}))]}
          />
        </Form.Item>
        <Form.Item>
          <Space direction="vertical" size="middle">
            <SwitchRow
              id="opt-metadata"
              checked={settings.embedMetadata}
              onChange={value => change({embedMetadata: value})}
            >
              {t('settings.metadata')}
            </SwitchRow>
            <SwitchRow
              id="opt-thumbnail"
              checked={settings.embedThumbnail}
              onChange={value => change({embedThumbnail: value})}
            >
              {t('settings.thumbnail')}
            </SwitchRow>
            <SwitchRow
              id="opt-notify"
              checked={settings.notifications}
              onChange={value => change({notifications: value})}
            >
              {t('settings.notifications')}
            </SwitchRow>
          </Space>
        </Form.Item>

        <Divider titlePlacement="start">{t('settings.appearance')}</Divider>
        <Form.Item label={t('header.language')}>
          <Segmented
            value={settings.language}
            options={[
              {label: 'English', value: 'en'},
              {label: 'Español', value: 'es'},
            ]}
            onChange={value => change({language: value as 'en' | 'es'})}
          />
        </Form.Item>
        <Form.Item label={t('header.theme')}>
          <Segmented
            value={settings.theme}
            options={[
              {label: t('theme.light'), value: 'light'},
              {label: t('theme.system'), value: 'system'},
              {label: t('theme.dark'), value: 'dark'},
            ]}
            onChange={value => change({theme: value as ThemeMode})}
          />
        </Form.Item>

        <Divider titlePlacement="start">{t('settings.tools')}</Divider>
        <Space>
          <Button icon={<MedicineBoxOutlined />} onClick={onDoctor}>
            {t('settings.doctor')}
          </Button>
          <Button icon={<ToolOutlined />} onClick={onReinstall}>
            {t('settings.reinstall')}
          </Button>
        </Space>
      </Form>
    </Drawer>
  )
}

/** A switch and its caption as one hit target (the caption is a real <label>). */
function SwitchRow({
  id,
  checked,
  onChange,
  children,
}: {
  readonly id: string
  readonly checked: boolean
  readonly onChange: (value: boolean) => void
  readonly children: string
}) {
  return (
    <span className="switch-row">
      <Switch id={id} checked={checked} onChange={onChange} />
      <label htmlFor={id}>{children}</label>
    </span>
  )
}
