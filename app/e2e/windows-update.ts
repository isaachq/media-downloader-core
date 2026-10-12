// The in-app update on a real Windows machine, end to end (CI, windows-latest):
// install version A with its NSIS installer, offer version B from a local
// feed, press "Update now" as a user does, and check what happens after the
// app closes — B installed for the same scope, the new version started — or,
// when the installer fails, the old version started again and saying why.
//
//   npx tsx app/e2e/windows-update.ts <A.exe> <B.exe> <B version> <user|machine> [fail]
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as http from 'node:http'
import type {AddressInfo} from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import {_electron as electron} from '@playwright/test'
import {writeFakes} from '../../test/helpers/fakes'

const [argA, argB, argVersion, argScope, mode] = process.argv.slice(2)
if (!argA || !argB || !argVersion || (argScope !== 'user' && argScope !== 'machine')) {
  console.error('usage: windows-update.ts <A.exe> <B.exe> <B version> <user|machine> [fail]')
  process.exit(2)
}
const installerA: string = argA
const installerB: string = argB
const versionB: string = argVersion
const scope: 'user' | 'machine' = argScope
const failing = mode === 'fail'
const KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
// a query that finds nothing still answers (exit 0), with nothing
const ps = (script: string) =>
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `${script}; exit 0`], {encoding: 'utf8'}).trim()

/**
 * Our uninstall entries, per hive: the app's exe and its version. The NSIS
 * installer leaves InstallLocation empty: DisplayIcon names the exe ("…\\Media Download Core.exe,0").
 */
function installs(): Array<{hive: string; exe: string; version: string}> {
  const found: Array<{hive: string; exe: string; version: string}> = []
  for (const hive of ['HKCU', 'HKLM']) {
    const out = ps(
      `Get-ItemProperty '${hive}:\\${KEY}\\*' -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like 'Media Download Core*' } | ForEach-Object { $_.DisplayIcon + '|' + $_.DisplayVersion }`,
    )
    for (const line of out.split(/\r?\n/).filter(Boolean)) {
      const [icon = '', version = ''] = line.split('|')
      found.push({hive, exe: icon.replace(/,\d+$/, '').replace(/^"|"$/g, ''), version})
    }
  }
  return found
}

const running = () =>
  Number(ps("(Get-Process -Name 'Media Download Core' -ErrorAction SilentlyContinue | Measure-Object).Count"))

async function main() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'mdc-winupdate-'))
  const dataDir = path.join(root, 'data')
  await fs.mkdir(dataDir, {recursive: true})

  // 1. version A, for the scope under test
  console.log(`installing A for ${scope}`)
  execFileSync(installerA, ['/S', scope === 'machine' ? '/allusers' : '/currentuser'], {stdio: 'inherit'})
  const before = installs()
  console.log('installed:', JSON.stringify(before))
  const mine = before.find(entry => entry.hive === (scope === 'machine' ? 'HKLM' : 'HKCU'))
  if (!mine) throw new Error(`A is not registered for ${scope}`)
  const exe = mine.exe

  // 2. a feed offering B (a failing "installer" in the failure run), verified by its SHA-256
  const payload = await fs.readFile(
    failing ? path.join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'where.exe') : installerB,
  )
  const digest = createHash('sha256').update(payload).digest('hex')
  let origin = ''
  const server = http.createServer((req, res) => {
    if (req.url === '/releases') {
      res.writeHead(200, {'Content-Type': 'application/json'})
      res.end(
        JSON.stringify([
          {
            tag_name: `app-v${versionB}`,
            draft: false,
            body: 'Update test',
            html_url: `${origin}/page`,
            assets: [
              {
                name: `Media-Download-Core-${versionB}-win-${process.arch === 'arm64' ? 'arm64' : 'x64'}.exe`,
                size: payload.length,
                digest: `sha256:${digest}`,
                browser_download_url: `${origin}/download/setup.exe`,
              },
            ],
          },
        ]),
      )
      return
    }
    res.writeHead(200, {'Content-Length': String(payload.length)})
    res.end(payload)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  // 3. the installed app, as a user starts it, with fake tools (no network) and this feed
  await fs.writeFile(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({language: 'en', theme: 'light', tourDone: true, validation: 'none'}),
  )
  const fakes = await writeFakes(path.join(root, 'fakes'))
  const app = await electron.launch({
    executablePath: exe,
    args: [],
    env: {
      ...process.env,
      MDC_DATA_DIR: dataDir,
      MDC_BINARIES: JSON.stringify(fakes),
      MDC_UPDATE_FEED: `${origin}/releases`,
      MDC_UPDATE_TRUSTED: `${origin}/download/`,
    },
  })
  const page = await app.firstWindow()
  await page.waitForSelector('[data-testid="theme-mode"]', {state: 'attached', timeout: 60_000})
  await page.getByRole('button', {name: /about/i}).click()
  await page.getByRole('button', {name: 'Check for updates'}).click()
  const closed = new Promise<void>(resolve => app.on('close', () => resolve()))
  await page.getByTestId('update-banner').getByRole('button', {name: 'Update now'}).click({timeout: 60_000})
  const pressed = Date.now()
  await closed
  console.log(`the app closed ${((Date.now() - pressed) / 1000).toFixed(1)} s after "Update now"`)

  // 4. what the helper did: B in place for the same scope and started — or A again, saying why
  const scopeHive = mine.hive
  const readTrace = async () => {
    const dir = path.join(dataDir, 'logs')
    const names = await fs.readdir(dir).catch(() => [] as string[])
    return (await Promise.all(names.map(name => fs.readFile(path.join(dir, name), 'utf8').catch(() => '')))).join('\n')
  }
  const helperLog = async () => {
    const log = await fs.readFile(path.join(dataDir, 'updates', 'install.log'), 'utf8').catch(() => '')
    // the version that starts next logs it ("last update: …") and deletes the file
    const traced =
      (await readTrace())
        .split('\n')
        .filter(line => line.includes('last update:'))
        .pop() ?? ''
    return `${log}${traced}`
  }
  const deadline = Date.now() + 4 * 60_000
  let done = false
  while (!done && Date.now() < deadline) {
    await sleep(3000)
    const now = installs()
    done = failing
      ? (await helperLog()).includes('NOT INSTALLED') && running() > 0
      : now.find(entry => entry.hive === scopeHive)?.version === versionB && running() > 0
  }
  await sleep(5000) // the new version's start-up logs the helper's steps
  server.close()
  const after = installs()
  console.log('installed after:', JSON.stringify(after))
  console.log('processes running:', running())
  console.log('helper log:', (await helperLog()) || '(none)')
  if (!done)
    throw new Error(
      `no ${failing ? 'reported failure with the old version running' : `${versionB} running for ${scope}`} within 4 minutes`,
    )
  if (!failing && after.length !== 1) throw new Error('installed twice (both scopes)')
  console.log(
    `OK: ${failing ? 'failed update reported, old version running' : `${versionB} installed for ${scope} and running`}`,
  )
  ps("Get-Process -Name 'Media Download Core' -ErrorAction SilentlyContinue | Stop-Process -Force")
}

main().catch(error => {
  console.error(error)
  try {
    ps("Get-Process -Name 'Media Download Core' -ErrorAction SilentlyContinue | Stop-Process -Force")
  } catch {}
  process.exit(1)
})
