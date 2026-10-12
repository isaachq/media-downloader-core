import type {PlayerPageSite} from './source.js'

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i

/**
 * The player-page sites a user configured, from their JSON file:
 *
 *   {"sites": [{"name": "…", "hosts": ["…"], "videoPath": "optional regex"}]}
 *
 * Strict on purpose: a typo should say what is wrong, not silently match
 * nothing. Throws a TypeError naming the first problem.
 */
export function parsePlayerPageSites(json: unknown): PlayerPageSite[] {
  const list = isObject(json) ? json['sites'] : undefined
  if (!Array.isArray(list)) throw new TypeError('Expected {"sites": [...]}.')
  const names = new Set<string>()
  return list.map((raw, i): PlayerPageSite => {
    const at = `sites[${i}]`
    if (!isObject(raw)) throw new TypeError(`${at} must be an object.`)
    const name = typeof raw['name'] === 'string' ? raw['name'].trim() : ''
    if (!name || name.length > 60) throw new TypeError(`${at}.name must be 1–60 characters.`)
    if (names.has(name.toLowerCase())) throw new TypeError(`${at}.name "${name}" is used twice.`)
    names.add(name.toLowerCase())
    const hosts = raw['hosts']
    if (!Array.isArray(hosts) || hosts.length === 0) throw new TypeError(`${at}.hosts must list at least one host.`)
    for (const host of hosts) {
      if (typeof host !== 'string' || !HOST.test(host))
        throw new TypeError(`${at}.hosts: "${String(host)}" is not a host name.`)
    }
    const videoPath = raw['videoPath']
    if (videoPath !== undefined) {
      if (typeof videoPath !== 'string') throw new TypeError(`${at}.videoPath must be a string.`)
      let pattern: RegExp
      try {
        pattern = new RegExp(videoPath)
      } catch (error) {
        throw new TypeError(`${at}.videoPath is not a valid regular expression: ${String(error)}`)
      }
      // the first group is the video id
      if (new RegExp(`${pattern.source}|`).exec('')!.length < 2)
        throw new TypeError(`${at}.videoPath needs a group for the id.`)
    }
    return {name, hosts: hosts as string[], ...(videoPath !== undefined && {videoPath: videoPath as string})}
  })
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
