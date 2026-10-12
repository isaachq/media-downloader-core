import {Alert, Button, Select, Space, Typography} from 'antd'
import {useEffect, useState} from 'react'
import {BROWSERS} from '../../../shared/contract'
import {useApp} from '../context'
import {finishesAt} from '../format'
import {useT} from '../i18n'
import {useStoreValue} from '../store'

/**
 * YouTube asked to confirm this is not a bot (too many requests from this
 * connection): what happens now — YouTube downloads wait and try again by
 * themselves — and how to go on at once: a browser's signed-in session.
 */
export function YouTubePause() {
  const t = useT()
  const {settings, updateSettings} = useApp()
  const until = useStoreValue(store => store.youtubePausedUntil)
  const [now, setNow] = useState(() => Date.now())
  const [browser, setBrowser] = useState<string>(settings.cookiesFromBrowser || 'chrome')
  useEffect(() => {
    if (!until) return
    setNow(Date.now())
    // the banner goes away by itself when the pause is over
    const timer = setInterval(() => setNow(Date.now()), 10_000)
    return () => clearInterval(timer)
  }, [until])
  if (!until || until <= now) return null
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
          <Typography.Text>
            {t('ytpause.text', {at: finishesAt((until - now) / 1000, settings.language, now)})}
          </Typography.Text>
          {using ? (
            <Typography.Text>{t('ytpause.using', {browser: using})}</Typography.Text>
          ) : (
            <>
              <Typography.Text>{t('ytpause.continue')}</Typography.Text>
              <Space.Compact>
                <Select
                  aria-label={t('settings.cookies')}
                  value={browser}
                  onChange={setBrowser}
                  options={BROWSERS.map(value => ({value, label: value}))}
                  className="browser-select"
                />
                <Button type="primary" onClick={() => void updateSettings({cookiesFromBrowser: browser})}>
                  {t('ytpause.use')}
                </Button>
              </Space.Compact>
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
