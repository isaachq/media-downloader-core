import {Alert, Modal, Space, Typography} from 'antd'
import {SITES, type SignInSite} from '../../../shared/sites'
import {useApp} from '../context'
import {type MessageKey, useT} from '../i18n'

const STEPS = ['signin.step1', 'signin.step2', 'signin.step3', 'signin.step4'] as const

/** The named sites where a session opens something: the supported-sites list's own words. */
const SIGN_IN_SITES = SITES.filter(entry => entry.signIn && entry.brand) as ReadonlyArray<
  (typeof SITES)[number] & {readonly site: Exclude<SignInSite, 'web'>; readonly brand: string}
>

/** The permission each system asks for, the first time a browser's cookies are read. */
function systemNote(platform: string): MessageKey {
  if (platform.startsWith('darwin')) return 'signin.mac'
  if (platform.startsWith('win')) return 'signin.windows'
  return 'signin.linux'
}

/**
 * How to use a signed-in session: sign in to the site in your own browser,
 * pick that browser here, and allow the one-time permission the system asks
 * for. The app reads the browser's cookies itself — nothing to copy or paste.
 */
export function SignInHelp({onClose}: {readonly onClose: () => void}) {
  const t = useT()
  const {info} = useApp()
  return (
    <Modal open title={t('signin.title')} onCancel={onClose} footer={null} width={640}>
      <Space orientation="vertical" size="middle" className="full" data-testid="signin-help">
        <Typography.Text type="secondary">{t('signin.intro')}</Typography.Text>
        <div>
          <Typography.Text strong>{t('signin.sites')}</Typography.Text>
          <ul className="signin-sites" data-testid="signin-sites">
            {SIGN_IN_SITES.map(entry => (
              <li key={entry.site} data-site={entry.site}>
                <Typography.Text>
                  <Typography.Text strong>{entry.brand}</Typography.Text>: {t(`sites.${entry.site}.needs`)}
                </Typography.Text>
              </li>
            ))}
          </ul>
          <Typography.Text type="secondary">{t('signin.twitchNote')}</Typography.Text>
        </div>
        <ol className="signin-steps">
          {STEPS.map(step => (
            <li key={step}>
              <Typography.Text>{t(step)}</Typography.Text>
            </li>
          ))}
        </ol>
        <Alert type="info" showIcon title={t(systemNote(info.platform))} data-testid="signin-system" />
        <Typography.Text type="secondary">{t('signin.privacy')}</Typography.Text>
      </Space>
    </Modal>
  )
}
