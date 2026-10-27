import Icon from '@ant-design/icons'
import type {GetProps} from 'antd'

type IconProps = Partial<GetProps<typeof Icon>>

/** Bluesky's butterfly: antd ships no icon for it. */
const BlueskySvg = () => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path d="M3.47 1.93C5.3 3.3 7.27 6.09 8 7.6c.73-1.51 2.7-4.3 4.53-5.67C13.85.94 16 .18 16 2.62c0 .49-.28 4.1-.44 4.69-.57 2.04-2.65 2.56-4.5 2.25 3.23.55 4.05 2.37 2.28 4.19-3.37 3.45-4.84-.87-5.22-1.97L8 11.4l-.12.38c-.38 1.1-1.85 5.42-5.22 1.97-1.77-1.82-.95-3.64 2.28-4.19-1.85.31-3.93-.21-4.5-2.25C.28 6.72 0 3.11 0 2.62 0 .18 2.15.94 3.47 1.93z" />
  </svg>
)

/** SoundCloud's cloud and bars: antd ships no icon for it. */
const SoundcloudSvg = () => (
  <svg viewBox="0 0 16 16" width="1em" height="1em" fill="currentColor" aria-hidden="true">
    <path d="M7.4 12.2V5.9a3.7 3.7 0 0 1 5.9 1.9 2.2 2.2 0 1 1 .4 4.4z" />
    <rect x="5.9" y="6.2" width="0.9" height="6" rx="0.45" />
    <rect x="4.4" y="7" width="0.9" height="5.2" rx="0.45" />
    <rect x="2.9" y="7.8" width="0.9" height="4.4" rx="0.45" />
    <rect x="1.4" y="9" width="0.9" height="3.2" rx="0.45" />
    <rect x="0" y="9.8" width="0.9" height="2.4" rx="0.45" />
  </svg>
)

export const BlueskyFilled = (props: IconProps) => <Icon component={BlueskySvg} {...props} />
export const SoundcloudFilled = (props: IconProps) => <Icon component={SoundcloudSvg} {...props} />
