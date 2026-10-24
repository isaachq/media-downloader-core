import {
  FacebookFilled,
  FileOutlined,
  GlobalOutlined,
  InstagramOutlined,
  TeamOutlined,
  TikTokOutlined,
  XOutlined,
  YoutubeFilled,
} from '@ant-design/icons'
import {Tag} from 'antd'
import type {ReactNode} from 'react'
import {useT} from '../i18n'
import {type SiteLabel, siteName} from '../site'

/** Each site's icon and tag colour (antd presets, so both themes read them). */
const LOOK: Readonly<Record<SiteLabel, {readonly icon: ReactNode; readonly color: string}>> = {
  youtube: {icon: <YoutubeFilled />, color: 'red'},
  tiktok: {icon: <TikTokOutlined />, color: 'cyan'},
  instagram: {icon: <InstagramOutlined />, color: 'purple'},
  facebook: {icon: <FacebookFilled />, color: 'blue'},
  vk: {icon: <TeamOutlined />, color: 'geekblue'},
  x: {icon: <XOutlined />, color: 'default'},
  web: {icon: <GlobalOutlined />, color: 'green'},
  file: {icon: <FileOutlined />, color: 'orange'},
}

/** The site a link was detected as: icon, name, its colour. */
export function SiteTag({site, className}: {readonly site: SiteLabel; readonly className?: string | undefined}) {
  const t = useT()
  const look = LOOK[site]
  return (
    <Tag color={look.color} icon={look.icon} data-testid="site-tag" data-site={site} {...(className && {className})}>
      {siteName(t, site)}
    </Tag>
  )
}
