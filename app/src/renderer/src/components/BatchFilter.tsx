import {FilterOutlined} from '@ant-design/icons'
import {Select} from 'antd'
import {createContext, useContext} from 'react'
import {useT} from '../i18n'

export type BatchOption = {readonly value: string; readonly label: string}

/** Pick one batch (or all of them) for a table; searchable, clearable. */
export function BatchFilter({
  value,
  options,
  onChange,
}: {
  readonly value: string | undefined
  readonly options: readonly BatchOption[]
  readonly onChange: (batchId: string | undefined) => void
}) {
  const t = useT()
  return (
    <Select
      allowClear
      showSearch
      optionFilterProp="label"
      value={value}
      placeholder={t('filter.allBatches')}
      aria-label={t('filter.label')}
      options={[...options]}
      onChange={next => onChange(next ?? undefined)}
      suffixIcon={<FilterOutlined />}
      style={{minWidth: 260, maxWidth: 420}}
      popupMatchSelectWidth={false}
      data-testid="batch-filter"
    />
  )
}

/** Where a batch card sends you: a tab, filtered to that batch. */
export type ShowBatch = (tab: 'jobs' | 'finished', batchId: string) => void
export const ShowBatchContext = createContext<ShowBatch>(() => {})
export const useShowBatch = (): ShowBatch => useContext(ShowBatchContext)
