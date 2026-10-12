import {PictureOutlined} from '@ant-design/icons'
import {InputNumber, Modal, Segmented, Space, Typography} from 'antd'
import {isAudioFormat} from '../../../shared/contract'
import {useApp} from '../context'
import {type MessageKey, useT} from '../i18n'

const MODES = ['video', 'images-audio', 'images'] as const

/**
 * What TikTok slideshows become: an MP4 (N seconds per image), a folder of
 * images with their sound, or images only. The choice is a setting, so the
 * next slideshow starts from it. With an audio format there's nothing to
 * choose: only the soundtrack is downloaded.
 */
export function SlideshowChoice({
  count,
  silent,
}: {
  readonly count?: number | undefined
  readonly silent?: number | undefined
}) {
  const t = useT()
  const {settings, updateSettings} = useApp()
  if (isAudioFormat(settings.format)) {
    return (
      <Typography.Text type="secondary" data-testid="slideshow-audio">
        {t('slides.audioFormat')}
      </Typography.Text>
    )
  }
  const mode = settings.slideshowMode
  return (
    <Space direction="vertical" size={6} className="full" data-testid="slideshow-choice">
      {count !== undefined ? (
        <Typography.Text strong>
          <PictureOutlined /> {t('slides.title', {count})}
          {silent ? (
            <Typography.Text type="secondary"> · {t('slides.noAudio', {count: silent})}</Typography.Text>
          ) : null}
        </Typography.Text>
      ) : null}
      <Space wrap align="center">
        <Segmented
          aria-label={t('slides.label')}
          value={mode}
          options={MODES.map(value => ({value, label: t(`slides.mode.${value}` as MessageKey)}))}
          onChange={value => void updateSettings({slideshowMode: value as (typeof MODES)[number]})}
        />
        {mode === 'video' ? (
          <InputNumber
            aria-label={t('slides.seconds')}
            addonBefore={t('slides.seconds')}
            min={1}
            max={30}
            value={settings.slideshowSeconds}
            onChange={value => void updateSettings({slideshowSeconds: value ?? 3})}
            style={{width: 210}}
          />
        ) : null}
      </Space>
      <Typography.Text type="secondary">
        {t(`slides.hint.${mode}` as MessageKey, {seconds: settings.slideshowSeconds})}
      </Typography.Text>
    </Space>
  )
}

/** One slideshow link: choose what it becomes, then download. */
export function SlideshowModal({
  title,
  onConfirm,
  onCancel,
}: {
  readonly title: string
  readonly onConfirm: () => void
  readonly onCancel: () => void
}) {
  const t = useT()
  return (
    <Modal
      open
      title={t('slides.single')}
      okText={t('slides.confirm')}
      cancelText={t('preview.cancel')}
      onOk={onConfirm}
      onCancel={onCancel}
      width={620}
    >
      <Space direction="vertical" className="full">
        <Typography.Text className="one-line" title={title}>
          {title}
        </Typography.Text>
        <SlideshowChoice />
      </Space>
    </Modal>
  )
}
