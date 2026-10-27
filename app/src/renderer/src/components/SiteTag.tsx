import {
  FacebookFilled,
  FileOutlined,
  GlobalOutlined,
  InstagramOutlined,
  SnapchatFilled,
  TeamOutlined,
  ThreadsFilled,
  TikTokOutlined,
  TwitchFilled,
  XOutlined,
  YoutubeFilled,
} from '@ant-design/icons'
import {Tag} from 'antd'
import type {ReactNode} from 'react'
import {useT} from '../i18n'
import {type SiteLabel, siteName} from '../site'
import {BlueskyFilled, SoundcloudFilled} from './siteIcons'

/** Each site's icon and tag colour (antd presets, so both themes read them). */
const LOOK: Readonly<Record<SiteLabel, {readonly icon: ReactNode; readonly color: string}>> = {
  youtube: {icon: <YoutubeFilled />, color: 'red'},
  tiktok: {icon: <TikTokOutlined />, color: 'cyan'},
  instagram: {icon: <InstagramOutlined />, color: 'purple'},
  facebook: {icon: <FacebookFilled />, color: 'blue'},
  vk: {icon: <TeamOutlined />, color: 'geekblue'},
  x: {icon: <XOutlined />, color: 'default'},
  threads: {icon: <ThreadsFilled />, color: 'default'},
  bluesky: {icon: <BlueskyFilled />, color: 'blue'},
  twitch: {icon: <TwitchFilled />, color: 'purple'},
  soundcloud: {icon: <SoundcloudFilled />, color: 'orange'},
  snapchat: {icon: <SnapchatFilled />, color: 'gold'},
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
