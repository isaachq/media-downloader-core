import {BUNDLE_CLIENT_ID, BUNDLE_OVERLAP, HYDRATION_CLIENT_ID, SCRIPT_SRC} from './endpoints.js'

/**
 * Where the anonymous `client_id` every api-v2 request carries comes from,
 * read the way the web app itself gets it: the home page's hydration names
 * one (free: it comes with the page, but flagged `isExpiring`), and the
 * app's last bundle script hard-codes the stable one. Pure functions over
 * text; the requests are the source's (paced, coalesced, cached).
 */

/** Every match in a window (matchAll copies the regex: no shared lastIndex). */
const BUNDLE_ALL = new RegExp(BUNDLE_CLIENT_ID.source, 'g')

/** The home page's api client id, if it names one. O(page). */
export function hydrationClientId(html: string): string | undefined {
  return HYDRATION_CLIENT_ID.exec(html)?.[1]
}

/**
 * The page's own bundle scripts (on `assetHost` only), **last first**: the
 * client id has been in the last one for years (yt-dlp walks them the same
 * way). O(page).
 */
export function bundleScripts(html: string, assetHost: string): string[] {
  const host = assetHost.replace(/\/+$/, '')
  const out: string[] = []
  for (const match of html.matchAll(SCRIPT_SRC)) {
    const src = match[1]
    if (src?.startsWith(`${host}/`) && src.endsWith('.js')) out.push(src)
  }
  return out.reverse()
}

/**
 * The client id in a script read as it streams: each chunk is searched
 * together with the last BUNDLE_OVERLAP characters of the one before, and
 * the read stops at the first match (`accept` says whether an id will do: one
 * the API just refused won't). Memory O(chunk), time O(bytes read): the 2.9
 * MB bundle is never held whole.
 */
export async function scanForClientId(
  body: ReadableStream<Uint8Array>,
  accept: (id: string) => boolean,
): Promise<string | undefined> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let carry = ''
  try {
    for (;;) {
      const {done, value} = await reader.read()
      const chunk = done ? decoder.decode() : decoder.decode(value, {stream: true})
      const window = carry + chunk
      for (const match of window.matchAll(BUNDLE_ALL)) {
        const id = match[1]
        if (id && accept(id)) return id
      }
      if (done) return undefined
      carry = window.slice(-BUNDLE_OVERLAP)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
}
