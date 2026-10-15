import {FolderOpenOutlined, MedicineBoxOutlined, ReloadOutlined, ToolOutlined, WarningOutlined} from '@ant-design/icons'
import {
  Alert,
  Button,
  Divider,
  Drawer,
  Empty,
  Flex,
  Form,
  Input,
  InputNumber,
  Modal,
  Radio,
  Segmented,
  Select,
  Slider,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd'
import type {DamagedEntry, ValidationLevel} from 'media-downloader-core'
import {useEffect, useState} from 'react'
import {
  type AppSettings,
  BROWSERS,
  concurrencyCap,
  RESTART_SETTINGS,
  RUN_MODES,
  type RunMode,
  type ThemeMode,
} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {moment} from '../format'
import {type MessageKey, useT} from '../i18n'
import {modeName} from '../mode'
import {type AppStore, BATCH_FINISHED, useStoreValue} from '../store'
import {SignInHelp} from './SignInHelp'

/** Batches not closed yet (scheduled, checking, running, validating): the mode can't change under them. */
const openBatches = (store: AppStore): number => {
  let open = 0
  for (const batch of store.batches.values()) if (!BATCH_FINISHED.has(batch.status)) open++
  return open
}

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

  const [damagedOpen, setDamagedOpen] = useState(false)
  const [signInOpen, setSignInOpen] = useState(false)
  const busy = useStoreValue(openBatches)
  const cap = concurrencyCap(info, settings)

  const change = (patch: Partial<AppSettings>) => {
    // the mode has its own notice (with a restart button)
    if (Object.keys(patch).some(key => key !== 'mode' && RESTART_SETTINGS.includes(key as keyof AppSettings)))
      setRestartNeeded(true)
    void updateSettings(patch)
  }
  const chooseFolder = async () => {
    const folder = await api().chooseFolder(settings.downloadDir)
    if (folder) change({downloadDir: folder})
  }

  return (
    <Drawer title={t('settings.title')} open={open} onClose={onClose} size={480} destroyOnHidden>
      {restartNeeded ? <Alert type="info" showIcon title={t('settings.restart')} className="restart-alert" /> : null}
      <Form layout="vertical">
        <div
          style={{
            padding: '12px 14px',
            marginBottom: 16,
            borderRadius: 8,
            border: '1px solid var(--ant-color-border-secondary, rgba(5, 5, 5, 0.06))',
            background: 'var(--ant-color-fill-quaternary, rgba(0, 0, 0, 0.02))',
          }}
        >
          <Typography.Text strong style={{display: 'block', marginBottom: 8}}>
            {t('settings.env')}
          </Typography.Text>
          <Space orientation="vertical" size={4} style={{width: '100%'}}>
            <Flex justify="space-between" align="center">
              <Typography.Text type="secondary">{t('settings.env.version')}</Typography.Text>
              <Tag color="blue">{info.version}</Tag>
            </Flex>
            <Flex justify="space-between" align="center">
              <Typography.Text type="secondary">{t('settings.env.concurrency')}</Typography.Text>
              <Typography.Text code>{t('settings.env.threads', {cap, cpus: info.cpus})}</Typography.Text>
            </Flex>
            <Flex justify="space-between" align="center">
              <Typography.Text type="secondary">{t('settings.env.platform')}</Typography.Text>
              <Typography.Text>{info.platform}</Typography.Text>
            </Flex>
          </Space>
        </div>
        <Divider titlePlacement="start">{t('settings.mode')}</Divider>
        <Form.Item extra={t('settings.modeHelp')} data-testid="settings-mode">
          <Radio.Group
            value={settings.mode}
            disabled={busy > 0}
            onChange={event => change({mode: event.target.value as RunMode})}
            aria-label={t('settings.mode')}
          >
            <Space orientation="vertical">
              {RUN_MODES.map(mode => (
                <Radio key={mode} value={mode} data-testid={`mode-${mode}`}>
                  <Typography.Text strong>{modeName(t, mode)}</Typography.Text>
                  <br />
                  <Typography.Text type="secondary">{t(`mode.${mode}.help` as MessageKey)}</Typography.Text>
                </Radio>
              ))}
            </Space>
          </Radio.Group>
        </Form.Item>
        {busy > 0 ? (
          <Alert type="info" showIcon title={t('settings.modeBusy', {count: busy})} className="restart-alert" />
        ) : null}
        {settings.mode !== info.mode ? (
          <Alert
            type="warning"
            showIcon
            className="restart-alert"
            data-testid="mode-restart"
            title={t('settings.modeRestart', {mode: modeName(t, settings.mode)})}
            action={
              <Button
                size="small"
                type="primary"
                icon={<ReloadOutlined />}
                disabled={busy > 0}
                onClick={() => void api().relaunch()}
              >
                {t('settings.restartNow')}
              </Button>
            }
          />
        ) : null}

        <Divider titlePlacement="start">{t('settings.downloads')}</Divider>
        <Form.Item label={t('settings.folder')}>
          <Space.Compact block>
            <Input readOnly value={settings.downloadDir} aria-label={t('settings.folder')} />
            <Button icon={<FolderOpenOutlined />} onClick={() => void chooseFolder()} />
          </Space.Compact>
        </Form.Item>
        <Form.Item
          label={`${t('settings.threads')}: ${settings.concurrency}`}
          extra={
            settings.cpuBoost
              ? t('settings.threadsHelpBoost', {max: cap, cpus: info.cpus})
              : t('settings.threadsHelp', {max: cap, cpus: info.cpus})
          }
        >
          <Slider
            aria-label={t('settings.threads')}
            min={1}
            max={cap}
            value={Math.min(settings.concurrency, cap)}
            marks={{1: '1', [cap]: String(cap)}}
            onChange={value => change({concurrency: value})}
          />
        </Form.Item>
        <Form.Item>
          <SwitchRow id="opt-boost" checked={settings.cpuBoost} onChange={value => change({cpuBoost: value})}>
            {t('settings.cpuBoost')}
          </SwitchRow>
          <Typography.Paragraph type="secondary" className="switch-help" data-testid="cpu-boost-help">
            {info.boostedConcurrency > info.maxConcurrency
              ? t('settings.cpuBoostHelp', {
                  half: info.maxConcurrency,
                  boosted: info.boostedConcurrency,
                  cpus: info.cpus,
                })
              : t('settings.cpuBoostSame', {half: info.maxConcurrency, cpus: info.cpus})}
          </Typography.Paragraph>
        </Form.Item>
        <Form.Item label={t('settings.validation')}>
          <Radio.Group
            value={settings.validation}
            onChange={event => change({validation: event.target.value as ValidationLevel})}
          >
            <Space orientation="vertical">
              <Radio value="full">{t('settings.validation.full')}</Radio>
              <Radio value="quick">{t('settings.validation.quick')}</Radio>
              <Radio value="none">{t('settings.validation.none')}</Radio>
            </Space>
          </Radio.Group>
        </Form.Item>
        <Form.Item>
          <SwitchRow
            id="opt-validate-after"
            checked={settings.validateAfter}
            disabled={settings.validation === 'none'}
            onChange={value => change({validateAfter: value})}
          >
            {t('settings.validateAfter')}
          </SwitchRow>
          <Typography.Paragraph type="secondary" className="switch-help">
            {t('settings.validateAfterHelp')}
          </Typography.Paragraph>
          <Button
            size="small"
            icon={<WarningOutlined />}
            onClick={() => setDamagedOpen(true)}
            data-testid="open-damaged"
          >
            {t('settings.damaged')}
          </Button>
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
        <Form.Item
          label={t('settings.cookies')}
          extra={
            <span>
              {t('settings.cookiesHelp')}{' '}
              <Button
                type="link"
                size="small"
                className="link-inline"
                onClick={() => setSignInOpen(true)}
                data-testid="open-signin-help"
              >
                {t('signin.open')}
              </Button>
            </span>
          }
        >
          <Select
            aria-label={t('settings.cookies')}
            value={settings.cookiesFromBrowser}
            onChange={(value: string) => change({cookiesFromBrowser: value})}
            options={[{value: '', label: t('settings.cookies.none')}, ...BROWSERS.map(b => ({value: b, label: b}))]}
          />
        </Form.Item>
        {info.mode === 'web' ? (
          <Form.Item label={t('settings.youtubeAccount')} data-testid="youtube-account">
            <YouTubeAccountRow />
          </Form.Item>
        ) : null}
        <Form.Item>
          <Space orientation="vertical" size="middle">
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
            {info.mode === 'tiktok' ? (
              <div>
                <SwitchRow
                  id="opt-sync"
                  checked={settings.syncEnabled}
                  onChange={value => change({syncEnabled: value})}
                >
                  {t('settings.sync')}
                </SwitchRow>
                <Typography.Paragraph type="secondary" className="switch-help">
                  {t('settings.syncHelp')}
                </Typography.Paragraph>
              </div>
            ) : null}
            <SwitchRow id="opt-update" checked={settings.autoUpdate} onChange={value => change({autoUpdate: value})}>
              {t('settings.autoUpdate')}
            </SwitchRow>
            <div>
              <SwitchRow
                id="opt-portable"
                checked={settings.portableNames}
                onChange={value => change({portableNames: value})}
              >
                {t('settings.portableNames')}
              </SwitchRow>
              <Typography.Paragraph type="secondary" className="switch-help">
                {t('settings.portableNamesHelp')}
              </Typography.Paragraph>
            </div>
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
      {damagedOpen ? <DamagedModal onClose={() => setDamagedOpen(false)} /> : null}
      {signInOpen ? <SignInHelp onClose={() => setSignInOpen(false)} /> : null}
    </Drawer>
  )
}

/** Videos found damaged at the source: never downloaded again, unless the user lets one try again. */
function DamagedModal({onClose}: {readonly onClose: () => void}) {
  const t = useT()
  const {settings} = useApp()
  const [entries, setEntries] = useState<readonly DamagedEntry[] | undefined>()
  const load = () => void api().damagedList().then(setEntries)
  useEffect(load, [])
  return (
    <Modal open title={t('damaged.title')} onCancel={onClose} footer={null} width={760}>
      <Space orientation="vertical" className="full" data-testid="damaged-modal">
        <Typography.Text type="secondary">{t('damaged.hint')}</Typography.Text>
        <Table<DamagedEntry>
          size="small"
          rowKey="key"
          loading={entries === undefined}
          dataSource={entries ? [...entries] : []}
          pagination={entries && entries.length > 20 ? {pageSize: 20, showSizeChanger: false} : false}
          locale={{emptyText: <Empty description={t('damaged.empty')} />}}
          scroll={{x: 640}}
          columns={[
            {
              title: t('job.title'),
              key: 'title',
              ellipsis: true,
              render: (_, entry) => (
                <Space orientation="vertical" size={0}>
                  <Typography.Text className="one-line" title={entry.title ?? entry.url}>
                    {entry.title ?? entry.url}
                  </Typography.Text>
                  <Typography.Text type="secondary" className="one-line" title={entry.reason}>
                    {entry.reason}
                  </Typography.Text>
                </Space>
              ),
            },
            {
              title: t('damaged.when'),
              key: 'at',
              width: 170,
              render: (_, entry) => moment(entry.at, settings.language),
            },
            {
              title: '',
              key: 'forget',
              width: 150,
              render: (_, entry) => (
                <Button size="small" onClick={() => void api().damagedForget(entry.key).then(load)}>
                  {t('damaged.forget')}
                </Button>
              ),
            },
          ]}
        />
      </Space>
    </Modal>
  )
}

/** A switch and its caption as one hit target (the caption is a real <label>). */
function SwitchRow({
  id,
  checked,
  disabled,
  onChange,
  children,
}: {
  readonly id: string
  readonly checked: boolean
  readonly disabled?: boolean | undefined
  readonly onChange: (value: boolean) => void
  readonly children: string
}) {
  return (
    <span className="switch-row">
      <Switch id={id} checked={checked} disabled={disabled === true} onChange={onChange} />
      <label htmlFor={id}>{children}</label>
    </span>
  )
}

/** The YouTube account signed in inside the app, if any — signing in happens only when YouTube requires it. */
function YouTubeAccountRow() {
  const t = useT()
  const signedIn = useStoreValue(store => store.youtube?.signedIn ?? false)
  if (!signedIn) return <Typography.Text type="secondary">{t('settings.youtubeNone')}</Typography.Text>
  return (
    <Space wrap>
      <Typography.Text>{t('settings.youtubeSignedIn')}</Typography.Text>
      <Button size="small" onClick={() => void api().youtubeSignOut()}>
        {t('settings.youtubeSignOut')}
      </Button>
    </Space>
  )
}
