import {StopOutlined} from '@ant-design/icons'
import {Button, Flex, Progress, Spin, Typography} from 'antd'
import {useEffect, useState} from 'react'
import type {AnalyzeProgress} from '../../../shared/contract'
import {api} from '../api'
import {useT} from '../i18n'

/**
 * While a link is read: how far a long listing has got (TikTok profiles report
 * every page), or how long it's been for links that can't tell (yt-dlp), and
 * a way out.
 */
export function AnalyzeLoader({onCancel}: {readonly onCancel: () => void}) {
  const t = useT()
  const [progress, setProgress] = useState<AnalyzeProgress | undefined>()
  const [seconds, setSeconds] = useState(0)

  useEffect(() => {
    const started = Date.now()
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000)
    const off = api().onAnalyzeProgress(setProgress)
    return () => {
      clearInterval(timer)
      off()
    }
  }, [])

  const listing = progress?.expected !== undefined && progress.expected > 0
  return (
    <Flex className="analyze-loader" data-testid="analyze-loader" align="center" gap={16}>
      <Spin size="small" />
      <Flex vertical flex={1} gap={2}>
        <Typography.Text>
          {listing
            ? t('analyze.listing', {listed: progress.listed, expected: progress.expected!})
            : t('analyze.reading', {seconds})}
        </Typography.Text>
        {listing ? (
          <Progress
            percent={Math.floor((progress.listed / progress.expected!) * 100)}
            size="small"
            status="active"
            showInfo={false}
          />
        ) : (
          <Typography.Text type="secondary" className="analyze-hint">
            {t('analyze.hint')}
          </Typography.Text>
        )}
      </Flex>
      <Button icon={<StopOutlined />} onClick={onCancel}>
        {t('analyze.cancel')}
      </Button>
    </Flex>
  )
}
