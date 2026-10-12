import {Listy, Typography} from 'antd'
import type {Key, ReactNode} from 'react'

/**
 * A short list of rows (tools, credits, links, posts) separated by a line —
 * Ant Design's Listy, rendered whole (these lists are small: at most a few
 * hundred rows), with an optional text when there are none.
 */
export function Rows<T>({
  items,
  rowKey,
  render,
  empty,
  className,
}: {
  readonly items: readonly T[]
  readonly rowKey: (item: T, index: number) => Key
  readonly render: (item: T, index: number) => ReactNode
  readonly empty?: ReactNode
  readonly className?: string
}) {
  if (items.length === 0 && empty !== undefined) return <Typography.Text type="secondary">{empty}</Typography.Text>
  // Listy keys rows by item; the index makes repeated values (two equal links) distinct
  const rows = items.map((item, index) => ({item, index}))
  return (
    <Listy
      virtual={false}
      items={rows}
      rowKey={row => rowKey(row.item, row.index)}
      itemRender={row => render(row.item, row.index)}
      className={className ? `rows ${className}` : 'rows'}
      classNames={{item: 'rows-item'}}
    />
  )
}
