/**
 * The data Instagram and Facebook embed in their pages for their own front
 * ends: many `<script type="application/json" data-sjs>` blocks, each a Relay
 * payload with the query results nested a dozen levels deep. Found with
 * `indexOf`, no HTML parser; searched with an explicit stack, no recursion
 * (a payload can be deep and wide). Everything here is O(size of the page).
 */

export type Json = Record<string, unknown>

export const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null
export const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined)
export const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}
export const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const SCRIPT_OPEN = '<script'
const SCRIPT_CLOSE = '</script>'
const JSON_TYPE = 'application/json'

/**
 * Every JSON script block of a page, parsed, in page order. Blocks that are
 * not JSON (or are empty) are skipped — a page carries other scripts too.
 * Only blocks whose tag says `application/json` are considered; `data-sjs`
 * is how both sites mark theirs, but the type is what makes them parseable.
 */
export function jsonScripts(html: string): unknown[] {
  const found: unknown[] = []
  let at = html.indexOf(SCRIPT_OPEN)
  while (at !== -1) {
    const tagEnd = html.indexOf('>', at)
    if (tagEnd === -1) break
    const tag = html.slice(at, tagEnd)
    const bodyEnd = html.indexOf(SCRIPT_CLOSE, tagEnd)
    if (bodyEnd === -1) break
    if (tag.includes(JSON_TYPE)) {
      const body = html.slice(tagEnd + 1, bodyEnd).trim()
      if (body.startsWith('{') || body.startsWith('[')) {
        try {
          found.push(JSON.parse(body))
        } catch {
          // a block this module doesn't need (or a truncated one): the others may hold the data
        }
      }
    }
    at = html.indexOf(SCRIPT_OPEN, bodyEnd + SCRIPT_CLOSE.length)
  }
  return found
}

/**
 * The first object anywhere in `roots` that has `key` (breadth is irrelevant:
 * these payloads hold one result per query). Depth-first with an explicit
 * stack; `limit` nodes at most, so a pathological page can't take forever.
 */
export function findWithKey(roots: readonly unknown[], key: string, limit = 200_000): Json | undefined {
  const stack: unknown[] = [...roots].reverse()
  let visited = 0
  while (stack.length > 0 && visited++ < limit) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i])
    } else if (isObject(node)) {
      if (key in node) return node
      // push in reverse so the first key is visited first (page order matters when a key repeats)
      const values = Object.values(node)
      for (let i = values.length - 1; i >= 0; i--) stack.push(values[i])
    }
  }
  return undefined
}

/**
 * Every object anywhere in `roots` that has `key`, in document order and
 * without duplicates (the same object may be reachable twice). Same bounded
 * walk as `findWithKey`, used where a page lists many items.
 */
export function findAllWithKey(roots: readonly unknown[], key: string, limit = 500_000): Json[] {
  const found: Json[] = []
  const seen = new Set<Json>()
  const stack: unknown[] = [...roots].reverse()
  let visited = 0
  while (stack.length > 0 && visited++ < limit) {
    const node = stack.pop()
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i--) stack.push(node[i])
    } else if (isObject(node)) {
      if (seen.has(node)) continue
      seen.add(node)
      if (key in node) found.push(node)
      const values = Object.values(node)
      for (let i = values.length - 1; i >= 0; i--) stack.push(values[i])
    }
  }
  return found
}

/** `path` of keys down from `root`, or undefined where it breaks. */
export function dig(root: unknown, ...path: ReadonlyArray<string | number>): unknown {
  let node = root
  for (const step of path) {
    if (typeof step === 'number') {
      if (!Array.isArray(node)) return undefined
      node = node[step]
    } else {
      if (!isObject(node)) return undefined
      node = node[step]
    }
  }
  return node
}

/** `&amp;` and friends in a url copied out of a script or an attribute. */
export function unescapeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\\\//g, '/')
}
