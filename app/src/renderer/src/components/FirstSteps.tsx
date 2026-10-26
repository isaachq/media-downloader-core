import {Tour, type TourProps} from 'antd'
import {useT} from '../i18n'

/** What the guide points at: elements marked with data-tour="…". */
const target = (name: string) => () => document.querySelector<HTMLElement>(`[data-tour="${name}"]`) as HTMLElement

/**
 * First steps, in four: paste a link, choose what to get, download (and
 * where the files show up), and what a list and the mix list are. Shown once
 * on the first launch; Header → Guide replays it. Closing it at any step
 * counts as seen.
 */
export function FirstSteps({open, onClose}: {readonly open: boolean; readonly onClose: () => void}) {
  const t = useT()
  const steps: TourProps['steps'] = [
    {title: t('tour.1.title'), description: t('tour.1.text'), target: target('url')},
    {title: t('tour.2.title'), description: t('tour.2.text'), target: target('options')},
    {title: t('tour.3.title'), description: t('tour.3.text'), target: target('download')},
    {title: t('tour.4.title'), description: t('tour.4.text'), target: target('mix')},
  ]
  return (
    <Tour
      open={open}
      steps={steps}
      onClose={onClose}
      onFinish={onClose}
      indicatorsRender={(current, total) => `${current + 1} / ${total}`}
      data-testid="first-steps"
    />
  )
}
