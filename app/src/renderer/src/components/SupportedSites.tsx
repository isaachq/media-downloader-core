import {CheckOutlined} from '@ant-design/icons'
import {Table, Typography} from 'antd'
import {SITE_BY_LABEL, SITES, type SiteLabel, type SupportedSite} from '../../../shared/sites'
import type {MessageKey} from '../i18n'
import {useT} from '../i18n'
import {SiteTag} from './SiteTag'

/** The sign-in cell, or the line under a pasted link: what needs the user's session, if anything. */
const needsKey = (site: SiteLabel) => `sites.${site}.needs` as MessageKey

/** Every supported site: what it downloads, whether it needs a sign-in, whether the phone has it. */
export function SupportedSites() {
  const t = useT()
  return (
    <div data-testid="supported-sites">
      <Typography.Paragraph type="secondary">{t('sites.intro')}</Typography.Paragraph>
      <Table<SupportedSite>
        size="small"
        pagination={false}
        rowKey="site"
        dataSource={[...SITES]}
        columns={[
          {
            title: t('sites.col.site'),
            key: 'site',
            render: (_, entry) => (
              <span data-site={entry.site}>
                <SiteTag site={entry.site} />
              </span>
            ),
          },
          {title: t('sites.col.what'), key: 'what', render: (_, entry) => t(`sites.${entry.site}.what`)},
          {
            title: t('sites.col.signIn'),
            key: 'signIn',
            render: (_, entry) =>
              entry.signIn ? (
                t('sites.signInFor', {what: t(needsKey(entry.site))})
              ) : (
                <Typography.Text type="secondary">{t('sites.notNeeded')}</Typography.Text>
              ),
          },
          {
            title: t('sites.col.phone'),
            key: 'phone',
            render: (_, entry) =>
              entry.phone ? (
                <CheckOutlined aria-label={t('sites.yes')} style={{color: 'var(--ok, #52c41a)'}} />
              ) : (
                <Typography.Text type="secondary">{t('sites.desktopOnly')}</Typography.Text>
              ),
          },
        ]}
      />
    </div>
  )
}

/** The line under a pasted link: what it downloads, whether it asks for a sign-in, if yt-dlp reads it. */
export function SiteLine({site}: {readonly site: SiteLabel}) {
  const t = useT()
  const entry = SITE_BY_LABEL[site]
  const parts = [t(`sites.${site}.what`)]
  if (entry.signIn) parts.push(t('sites.inlineSignIn', {what: t(needsKey(site))}))
  if (entry.engine === 'yt-dlp') parts.push(t('sites.ytDlp'))
  return (
    <Typography.Text type="secondary" style={{fontSize: 12}} data-testid="site-line">
      {parts.join(' · ')}
    </Typography.Text>
  )
}
