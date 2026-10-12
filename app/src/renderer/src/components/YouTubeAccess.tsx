import {Alert, Button, Modal, Select, Space, Typography} from 'antd'
import {useEffect, useState} from 'react'
import {BROWSERS} from '../../../shared/contract'
import {api} from '../api'
import {useApp} from '../context'
import {finishesAt} from '../format'
import {useT} from '../i18n'
import {useStoreValue} from '../store'

/**
 * YouTube asked to confirm this is not a bot. What the user sees follows how
 * far the engine had to go, and asks for something only when it must:
 *  - paused, with the app's verification tokens: a note — it goes on by itself;
 *  - paused, without tokens: the note, and a browser's signed-in session to go on at once;
 *  - held (tokens were not enough): why, and the choice — sign in, a browser, or wait.
 *    The downloads are waiting, not failed: they go on from where they were.
 */
export function YouTubeAccess() {
  const youtube = useStoreValue(store => store.youtube)
  const until = useStoreValue(store => store.youtubePausedUntil)
  if (youtube?.level === 'held') return <YouTubeHeld signedIn={youtube.signedIn} />
  return <YouTubePause until={until} tokens={youtube?.tokens ?? false} />
}

function YouTubePause({until, tokens}: {until: number | undefined; tokens: boolean}) {
  const t = useT()
  const {settings, updateSettings} = useApp()
  const [now, setNow] = useState(() => Date.now())
  const [browser, setBrowser] = useState<string>(settings.cookiesFromBrowser || 'chrome')
  useEffect(() => {
    if (!until) return
    setNow(Date.now())
    // the note goes away by itself when the pause is over
    const timer = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(timer)
  }, [until])
  if (!until || until <= now) return null
  const at = finishesAt((until - now) / 1000, settings.language, now)
  if (tokens) {
    return (
      <Alert
        type="info"
        showIcon
        className="youtube-pause"
        data-testid="youtube-pause"
        title={t('ytpause.title')}
        description={t('ytpause.tokens', {at})}
      />
    )
  }
  const using = settings.cookiesFromBrowser
  return (
    <Alert
      type="warning"
      showIcon
      className="youtube-pause"
      data-testid="youtube-pause"
      title={t('ytpause.title')}
      description={
        <Space orientation="vertical" size={6} className="full">
          <Typography.Text>{t('ytpause.text', {at})}</Typography.Text>
          {using ? (
            <Typography.Text>{t('ytpause.using', {browser: using})}</Typography.Text>
          ) : (
            <>
              <Typography.Text>{t('ytpause.continue')}</Typography.Text>
              <BrowserChoice
                value={browser}
                onChange={setBrowser}
                onUse={() => void updateSettings({cookiesFromBrowser: browser})}
              />
            </>
          )}
          {(using || browser) === 'safari' ? (
            <Typography.Text type="secondary">{t('ytpause.safari')}</Typography.Text>
          ) : null}
        </Space>
      }
    />
  )
}

function YouTubeHeld({signedIn}: {signedIn: boolean}) {
  const t = useT()
  const {settings, updateSettings} = useApp()
  const [browser, setBrowser] = useState<string>(settings.cookiesFromBrowser || 'chrome')
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<'closed' | 'refused' | undefined>()
  const signIn = async () => {
    setBusy(true)
    setProblem(undefined)
    try {
      const result = await api().youtubeSignIn()
      if (!result.ok) setProblem(result.reason ?? 'refused')
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open
      centered
      closable={false}
      mask={{closable: false}}
      keyboard={false}
      title={t('ytheld.title')}
      data-testid="youtube-held"
      footer={
        <Space wrap>
          <Button onClick={() => void api().youtubeWait()} disabled={busy}>
            {t('ytheld.wait')}
          </Button>
          <Button type="primary" loading={busy} onClick={() => void signIn()}>
            {signedIn ? t('ytheld.continueAccount') : t('ytheld.signIn')}
          </Button>
        </Space>
      }
    >
      <Space orientation="vertical" size={10} className="full" data-testid="youtube-held-body">
        <Typography.Text>{t('ytheld.why')}</Typography.Text>
        <Typography.Text strong>{t('ytheld.paused')}</Typography.Text>
        <Typography.Text>{t('ytheld.account')}</Typography.Text>
        {problem ? (
          <Alert type="error" showIcon title={t(problem === 'closed' ? 'ytheld.closed' : 'ytheld.refused')} />
        ) : null}
        <Typography.Text type="secondary">{t('ytheld.browser')}</Typography.Text>
        <BrowserChoice
          value={browser}
          onChange={setBrowser}
          onUse={() => void updateSettings({cookiesFromBrowser: browser})}
        />
        {browser === 'safari' ? <Typography.Text type="secondary">{t('ytpause.safari')}</Typography.Text> : null}
      </Space>
    </Modal>
  )
}

function BrowserChoice(props: {value: string; onChange: (value: string) => void; onUse: () => void}) {
  const t = useT()
  return (
    <Space.Compact>
      <Select
        aria-label={t('settings.cookies')}
        value={props.value}
        onChange={props.onChange}
        options={BROWSERS.map(value => ({value, label: value}))}
        className="browser-select"
      />
      <Button onClick={props.onUse}>{t('ytpause.use')}</Button>
    </Space.Compact>
  )
}
