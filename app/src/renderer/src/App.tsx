import {App as AntApp, ConfigProvider, Layout, Tabs, Typography, theme} from 'antd'
import enUS from 'antd/locale/en_US'
import esES from 'antd/locale/es_ES'
import type {BatchSnapshot, Diagnosis} from 'media-downloader-core'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import type {AppInfo, AppSettings} from '../../shared/contract'
import {api} from './api'
import {BOOT_PHASES, type BootPhase, type BootProgress, bootErrorMessage, retrying} from './boot'
import {AboutModal} from './components/AboutModal'
import {BatchList} from './components/BatchList'
import {BootScreen} from './components/BootScreen'
import {DownloadBar} from './components/DownloadBar'
import {Header} from './components/Header'
import {JobTable} from './components/JobTable'
import {LogsDrawer} from './components/LogsDrawer'
import {SettingsDrawer} from './components/SettingsDrawer'
import {SetupModal} from './components/SetupModal'
import {Stats} from './components/Stats'
import {AppContext, type AppContextValue} from './context'
import {I18nContext, type Translate, translator} from './i18n'
import {AppStore, StoreContext} from './store'

const CYAN = '#13a8e0'
const FINISHED = new Set(['completed', 'completed-with-errors', 'failed', 'cancelled'])

function useSystemDark(): boolean {
  const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : undefined
  const [dark, setDark] = useState(query?.matches ?? false)
  useEffect(() => {
    if (!query) return undefined
    const listener = (event: MediaQueryListEvent) => setDark(event.matches)
    query.addEventListener('change', listener)
    return () => query.removeEventListener('change', listener)
  }, [query])
  return dark
}

/** Batch-finished notifications: fired once, on the transition into a final status. */
function useBatchNotifications(t: Translate, settings: AppSettings) {
  const {notification} = AntApp.useApp()
  const seen = useRef(new Map<string, BatchSnapshot['status']>())
  return useCallback(
    (batches: readonly BatchSnapshot[]) => {
      for (const batch of batches) {
        const before = seen.current.get(batch.id)
        seen.current.set(batch.id, batch.status)
        if (!settings.notifications || before === undefined || FINISHED.has(before) || !FINISHED.has(batch.status))
          continue
        const title = batch.title ?? batch.url
        if (batch.status === 'failed') {
          notification.error({
            message: batch.error?.code === 'disk-full' ? t('notify.diskFull') : t('notify.batchFailed'),
            description: batch.error?.message ?? title,
          })
        } else if (batch.status !== 'cancelled') {
          const total = batch.preflight.total || batch.jobs.total
          notification[batch.status === 'completed' ? 'success' : 'warning']({
            message: t('notify.batchDone'),
            description: t(settings.validation === 'none' ? 'notify.batchDoneBodyUnverified' : 'notify.batchDoneBody', {
              title,
              succeeded: batch.jobs.succeeded,
              total,
            }),
          })
        }
      }
    },
    [settings.notifications, settings.validation, notification, t],
  )
}

function Shell({
  info,
  settings,
  dark,
  initialDiagnosis,
  target,
}: {
  readonly info: AppInfo
  readonly settings: AppSettings
  readonly dark: boolean
  readonly initialDiagnosis: Diagnosis
  readonly target: AppStore
}) {
  const t = useMemo(() => translator(settings.language), [settings.language])
  const notify = useBatchNotifications(t, settings)
  const [panel, setPanel] = useState<'logs' | 'settings' | 'about' | undefined>()
  const [diagnosis, setDiagnosis] = useState(initialDiagnosis)
  const [setup, setSetup] = useState<{open: boolean; force: boolean}>({open: !initialDiagnosis.ready, force: false})

  useEffect(
    () =>
      api().onEvents(bundle => {
        target.apply(bundle)
        if (bundle.batches.length) notify(bundle.batches)
      }),
    [notify, target],
  )

  const runDoctor = async () => {
    setDiagnosis(await api().doctor())
    setSetup({open: true, force: false})
  }

  return (
    <I18nContext.Provider value={t}>
      <Layout className="app-layout">
        <Header
          onLogs={() => setPanel('logs')}
          onSettings={() => setPanel('settings')}
          onAbout={() => setPanel('about')}
        />
        <Layout.Content className="app-content">
          <DownloadBar />
          <Stats />
          <Tabs
            className="main-tabs"
            // only the visible tab renders: a hidden 1,500-row table must not follow every event
            destroyOnHidden
            items={[
              {key: 'batches', label: t('tabs.batches'), children: <BatchList />},
              {key: 'jobs', label: t('tabs.jobs'), children: <JobTable />},
            ]}
          />
        </Layout.Content>
        <Layout.Footer className="app-footer">
          <Typography.Text type="secondary">
            Media Download Core {info.version} · Built with Ant Design · yt-dlp · FFmpeg
          </Typography.Text>
        </Layout.Footer>
      </Layout>
      <SettingsDrawer
        open={panel === 'settings'}
        onClose={() => setPanel(undefined)}
        onDoctor={() => void runDoctor()}
        onReinstall={() => setSetup({open: true, force: true})}
      />
      <LogsDrawer open={panel === 'logs'} onClose={() => setPanel(undefined)} />
      <AboutModal open={panel === 'about'} onClose={() => setPanel(undefined)} />
      <SetupModal
        open={setup.open}
        force={setup.force}
        diagnosis={diagnosis}
        onDone={setDiagnosis}
        onClose={() => setSetup({open: false, force: false})}
      />
      <span hidden data-testid="theme-mode">
        {dark ? 'dark' : 'light'}
      </span>
    </I18nContext.Provider>
  )
}

/** Root: loads everything once, then renders the shell inside the theme / locale providers. */
export function App({target: injected}: {readonly target?: AppStore}) {
  const [target] = useState(() => injected ?? new AppStore())
  const [boot, setBoot] = useState<{info: AppInfo; settings: AppSettings; diagnosis: Diagnosis} | undefined>()
  const [progress, setProgress] = useState<BootProgress>({status: 'running', phase: 'connect', attempt: 1})
  const systemDark = useSystemDark()
  // what the finished phases produced: a retry resumes at the phase that failed
  const loaded = useRef<{info?: AppInfo; settings?: AppSettings; restored?: true; diagnosis?: Diagnosis}>({})
  const starting = useRef(false)

  const start = useCallback(async () => {
    if (starting.current) return // StrictMode runs effects twice in development
    starting.current = true
    const bridge = api()
    const done = loaded.current
    const phases: Record<BootPhase, {readonly finished: () => boolean; readonly run: () => Promise<unknown>}> = {
      connect: {finished: () => done.info !== undefined, run: async () => (done.info = await bridge.info())},
      settings: {
        finished: () => done.settings !== undefined,
        run: async () => (done.settings = await bridge.getSettings()),
      },
      restore: {
        finished: () => done.restored === true,
        run: async () => {
          target.load(await bridge.state())
          done.restored = true
        },
      },
      tools: {finished: () => done.diagnosis !== undefined, run: async () => (done.diagnosis = await bridge.doctor())},
    }
    try {
      for (const phase of BOOT_PHASES) {
        if (phases[phase].finished()) continue
        try {
          await retrying(phases[phase].run, attempt => setProgress({status: 'running', phase, attempt}))
        } catch (error) {
          setProgress({status: 'failed', phase, error: bootErrorMessage(error)})
          return
        }
      }
      setBoot({info: done.info!, settings: done.settings!, diagnosis: done.diagnosis!})
    } finally {
      starting.current = false
    }
  }, [target])

  useEffect(() => {
    void start()
  }, [start])

  const updateSettings = useCallback(async (patch: Partial<AppSettings>) => {
    const settings = await api().setSettings(patch)
    setBoot(current => (current ? {...current, settings} : current))
  }, [])

  if (!boot) {
    // before settings arrive, follow the system language and theme
    const early = loaded.current.settings
    const language = early?.language ?? (navigator.language.toLowerCase().startsWith('es') ? 'es' : 'en')
    const bootDark = early ? early.theme === 'dark' || (early.theme === 'system' && systemDark) : systemDark
    return (
      <ConfigProvider
        theme={{
          algorithm: bootDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
          token: {colorPrimary: CYAN, colorInfo: CYAN},
        }}
      >
        <div className={bootDark ? 'theme-dark boot-root' : 'theme-light boot-root'}>
          <BootScreen progress={progress} t={translator(language)} onRetry={() => void start()} />
        </div>
      </ConfigProvider>
    )
  }

  const dark = boot.settings.theme === 'dark' || (boot.settings.theme === 'system' && systemDark)
  const context: AppContextValue = {info: boot.info, settings: boot.settings, dark, updateSettings}
  return (
    <ConfigProvider
      locale={boot.settings.language === 'es' ? esES : enUS}
      theme={{
        algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: CYAN,
          colorInfo: CYAN,
          borderRadius: 10,
          fontFamily: 'Inter, system-ui, -apple-system, Segoe UI, sans-serif',
        },
      }}
    >
      <AntApp message={{top: 96, maxCount: 3}} notification={{top: 96, maxCount: 4}}>
        <StoreContext.Provider value={target}>
          <AppContext.Provider value={context}>
            <div className={dark ? 'theme-dark' : 'theme-light'}>
              <Shell
                info={boot.info}
                settings={boot.settings}
                dark={dark}
                initialDiagnosis={boot.diagnosis}
                target={target}
              />
            </div>
          </AppContext.Provider>
        </StoreContext.Provider>
      </AntApp>
    </ConfigProvider>
  )
}
