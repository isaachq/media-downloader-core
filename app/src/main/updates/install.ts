import {execFile, spawn} from 'node:child_process'
import {randomUUID} from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {promisify} from 'node:util'
import {UpdateError} from './download'
import type {InstallKind} from './feed'

const run = promisify(execFile)
/** Package name of the .deb / .rpm (electron-builder derives it from package.json "name"). */
const PACKAGE = 'media-download-core-app'

/**
 * How this copy was installed. Undefined when it can't update itself (running
 * from source, or an install this updater doesn't recognize) — the UI then
 * points to the releases page instead.
 */
export async function detectInstallKind(execPath: string, env: NodeJS.ProcessEnv): Promise<InstallKind | undefined> {
  if (process.platform === 'darwin') return bundleOf(execPath) ? 'mac-app' : undefined
  if (process.platform === 'win32') return 'windows-nsis'
  if (process.platform !== 'linux') return undefined
  if (env['APPIMAGE']) return 'linux-appimage'
  if (await succeeds('dpkg-query', ['-W', PACKAGE])) return 'linux-deb'
  if (await succeeds('rpm', ['-q', PACKAGE])) return 'linux-rpm'
  return undefined
}

/** "/Applications/X.app/Contents/MacOS/X" → "/Applications/X.app". */
export function bundleOf(execPath: string): string | undefined {
  const at = execPath.indexOf('.app/Contents/MacOS/')
  return at === -1 ? undefined : execPath.slice(0, at + 4)
}

async function succeeds(command: string, args: string[]): Promise<boolean> {
  try {
    await run(command, args, {timeout: 10_000})
    return true
  } catch {
    return false
  }
}

export type InstallContext = {
  readonly kind: InstallKind
  /** The verified downloaded file. */
  readonly file: string
  readonly version: string
  readonly bundleId: string
  readonly execPath: string
  readonly pid: number
  readonly env: NodeJS.ProcessEnv
  /** Where scripts and staging folders go. */
  readonly workDir: string
}

/**
 * Put the new version in place. Returns how the app should leave:
 *  - 'quit': a helper waits for this process to exit, swaps the files and
 *    starts the new version (macOS bundle, AppImage, Windows installer);
 *  - 'relaunch': already installed (deb / rpm through the system's password
 *    prompt) — restart in place.
 */
export async function installUpdate(ctx: InstallContext): Promise<'quit' | 'relaunch'> {
  switch (ctx.kind) {
    case 'mac-app':
      return installMac(ctx)
    case 'windows-nsis':
      return installWindows(ctx)
    case 'linux-appimage':
      return installAppImage(ctx)
    case 'linux-deb':
      await elevated(['dpkg', '-i', ctx.file])
      return 'relaunch'
    case 'linux-rpm':
      await elevated(
        (await succeeds('dnf', ['--version']))
          ? ['dnf', 'install', '-y', ctx.file]
          : ['rpm', '-U', '--force', ctx.file],
      )
      return 'relaunch'
  }
}

// ─── macOS ───────────────────────────────────────────────────────────────────

/**
 * Unzip the new bundle next to the scripts, check it is really this app at the
 * offered version with a valid signature, then hand the swap to a helper
 * that runs after this process has exited (a running bundle can't replace
 * itself). The old bundle is kept until the new one is in place.
 */
async function installMac(ctx: InstallContext): Promise<'quit'> {
  const current = bundleOf(ctx.execPath)
  if (!current) throw new UpdateError('This copy is not an app bundle and can’t update itself.')
  if (current.includes('/AppTranslocation/')) {
    throw new UpdateError('Move Media Download Core to the Applications folder first, then update.')
  }
  await fs.access(path.dirname(current), fs.constants.W_OK).catch(() => {
    throw new UpdateError(`No permission to replace the app in ${path.dirname(current)}.`)
  })
  const staging = path.join(ctx.workDir, `staging-${ctx.version}`)
  await fs.rm(staging, {recursive: true, force: true})
  await fs.mkdir(staging, {recursive: true})
  await run('/usr/bin/ditto', ['-x', '-k', ctx.file, staging])
  const name = (await fs.readdir(staging)).find(entry => entry.endsWith('.app'))
  if (!name) throw new UpdateError('The update does not contain the app.')
  const fresh = path.join(staging, name)
  const plist = path.join(fresh, 'Contents', 'Info.plist')
  const read = async (key: string) => (await run('/usr/bin/plutil', ['-extract', key, 'raw', plist])).stdout.trim()
  if ((await read('CFBundleIdentifier')) !== ctx.bundleId) throw new UpdateError('The update is a different app.')
  if ((await read('CFBundleShortVersionString')) !== ctx.version)
    throw new UpdateError('The update is not the expected version.')
  try {
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', fresh])
  } catch {
    throw new UpdateError('The update’s code signature is not valid.')
  }
  const script = path.join(ctx.workDir, 'swap.sh')
  await fs.writeFile(
    script,
    [
      '#!/bin/sh',
      '# Media Download Core: swap the app bundle once the running copy has quit',
      'PID="$1"; OLD="$2"; NEW="$3"; BACKUP="$OLD.previous"',
      'i=0; while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 3000 ]; do sleep 0.1; i=$((i+1)); done',
      'kill -0 "$PID" 2>/dev/null && exit 1  # still running after 5 min: leave everything as it was',
      'rm -rf "$BACKUP"',
      'if mv "$OLD" "$BACKUP" && mv "$NEW" "$OLD"; then rm -rf "$BACKUP"',
      'elif [ -d "$BACKUP" ] && [ ! -d "$OLD" ]; then mv "$BACKUP" "$OLD"; fi',
      'xattr -dr com.apple.quarantine "$OLD" 2>/dev/null',
      'open "$OLD"',
      '',
    ].join('\n'),
    {mode: 0o755},
  )
  detached('/bin/sh', [script, String(ctx.pid), current, fresh])
  return 'quit'
}

// ─── Windows ─────────────────────────────────────────────────────────────────

/** What the Windows script writes, step by step: read back on the next start (`lastInstall`). */
export const INSTALL_LOG = 'install.log'
/** The line that marks an update that did not go in. */
export const NOT_INSTALLED = 'NOT INSTALLED:'
/** How install.log names the version it installs ("update to 0.2.0-beta.8: file.exe"). */
export const UPDATE_TO = 'update to'

/**
 * Where this copy is installed, as the NSIS installer sees it: for everyone
 * (registered under HKLM, usually Program Files) or for this user (HKCU).
 * A silent update has to say the same (`/allusers` / `/currentuser`), and
 * an install for everyone needs an administrator's permission.
 */
export async function windowsScope(
  execPath: string,
  query: (args: string[]) => Promise<string> = async args => (await run('reg', args, {timeout: 10_000})).stdout,
): Promise<'machine' | 'user'> {
  const dir = normalizeDir(path.win32.dirname(execPath))
  const KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
  for (const [hive, scope, views] of [
    ['HKCU', 'user', [[]]],
    ['HKLM', 'machine', [[], ['/reg:32']]],
  ] as const) {
    for (const view of views) {
      const out = await query(['query', `${hive}\\${KEY}`, '/s', ...view]).catch(() => '')
      for (const line of out.split(/\r?\n/)) {
        const where = folderIn(line)
        if (where !== undefined && where === dir) return scope
      }
    }
  }
  // not registered (a copied folder, an older installer): a folder only an administrator may write is "everyone"
  return (await writable(path.win32.dirname(execPath))) ? 'user' : 'machine'
}

/**
 * The folder an uninstall entry's line names: InstallLocation (often left
 * empty by NSIS), DisplayIcon ("…\\App.exe,0") or UninstallString
 * ("\"…\\Uninstall App.exe\" /currentuser").
 */
function folderIn(line: string): string | undefined {
  const match = /^\s+(InstallLocation|DisplayIcon|UninstallString)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line)
  if (!match) return undefined
  const value = match[2]!
  if (match[1]!.toLowerCase() === 'installlocation') return normalizeDir(value)
  const file = value.startsWith('"')
    ? value.slice(1, value.indexOf('"', 1))
    : value.replace(/,\d+$/, '').split(' /')[0]!
  return normalizeDir(path.win32.dirname(file))
}

const normalizeDir = (dir: string): string =>
  dir
    .trim()
    .replace(/^"|"$/g, '')
    .replace(/[\\/]+$/, '')
    .toLowerCase()

/**
 * Whether this process may create files in `dir`, by creating one. On
 * Windows `fs.access(W_OK)` reads only the read-only attribute: it says yes
 * for Program Files, which only an administrator may write (seen on a real
 * machine: access OK, write EPERM).
 */
export async function writable(dir: string): Promise<boolean> {
  const probe = path.join(dir, `.mdc-write-test-${process.pid}-${randomUUID()}`)
  try {
    await (await fs.open(probe, 'wx')).close()
  } catch {
    return false
  }
  await fs.rm(probe, {force: true}).catch(() => {})
  return true
}

/**
 * The NSIS installer's own update mode, as electron-updater runs it:
 * `--updated` makes it wait for this app to close (and close what is left of
 * it), `/S` installs silently for the same scope, `--force-run` starts the
 * new version. No helper of ours in between: on Windows a PowerShell helper
 * started by the app died with it, before its first line (reproduced on a
 * real machine).
 */
export function windowsInstallerArgs(scope: 'machine' | 'user'): string[] {
  return ['--updated', '/S', '--force-run', scope === 'machine' ? '/allusers' : '/currentuser']
}

/**
 * Hand the update to the NSIS installer, which runs once this process has
 * exited. Each step goes to install.log; whether the update went in is known
 * on the next start (Updater.cleanUp compares the version then running with
 * the one installed here).
 */
async function installWindows(ctx: InstallContext): Promise<'quit'> {
  const log = path.join(ctx.workDir, INSTALL_LOG)
  const step = (text: string) => fs.appendFile(log, `${new Date().toISOString()} ${text}\r\n`)
  await step(`${UPDATE_TO} ${ctx.version}: ${path.basename(ctx.file)}`)
  const scope = await windowsScope(ctx.execPath)
  const elevate = scope === 'machine' && !(await writable(path.win32.dirname(ctx.execPath)))
  await step(`installed for ${scope}${elevate ? ', needs an administrator' : ''}`)
  const args = windowsInstallerArgs(scope)
  // electron-builder ships elevate.exe with NSIS apps: the Windows administrator prompt, then the installer
  const elevateExe = path.join(path.win32.dirname(ctx.execPath), 'resources', 'elevate.exe')
  const launch = (command: string, commandArgs: string[]) =>
    new Promise<string>(resolve => {
      const child = spawn(command, commandArgs, {detached: true, stdio: 'ignore'})
      child.once('spawn', () => {
        child.unref()
        resolve(`installer started (pid ${child.pid})`)
      })
      child.once('error', error => resolve(`${NOT_INSTALLED} the installer could not start: ${error.message}`))
    })
  let started =
    elevate && (await exists(elevateExe)) ? await launch(elevateExe, [ctx.file, ...args]) : await launch(ctx.file, args)
  // an installer Windows won't start without an administrator: through elevate.exe, as electron-updater does
  if (started.startsWith(NOT_INSTALLED) && /EACCES|UNKNOWN|elevation/i.test(started) && (await exists(elevateExe))) {
    started = await launch(elevateExe, [ctx.file, ...args])
  }
  await step(started)
  if (started.startsWith(NOT_INSTALLED)) throw new UpdateError(started.slice(NOT_INSTALLED.length).trim())
  return 'quit'
}

const exists = (file: string): Promise<boolean> =>
  fs.access(file).then(
    () => true,
    () => false,
  )

// ─── Linux ───────────────────────────────────────────────────────────────────

async function installAppImage(ctx: InstallContext): Promise<'quit'> {
  const current = ctx.env['APPIMAGE']
  if (!current) throw new UpdateError('Not running from an AppImage.')
  await fs.access(path.dirname(current), fs.constants.W_OK).catch(() => {
    throw new UpdateError(`No permission to replace ${current}.`)
  })
  // stage next to the old file so the final move is a rename on the same disk
  const staged = `${current}.update`
  await fs.copyFile(ctx.file, staged)
  await fs.chmod(staged, 0o755)
  const script = path.join(ctx.workDir, 'swap-appimage.sh')
  await fs.writeFile(
    script,
    [
      '#!/bin/sh',
      '# Media Download Core: replace the AppImage once the running copy has quit',
      'PID="$1"; OLD="$2"; NEW="$3"',
      'i=0; while kill -0 "$PID" 2>/dev/null && [ "$i" -lt 3000 ]; do sleep 0.1; i=$((i+1)); done',
      'kill -0 "$PID" 2>/dev/null && exit 1  # still running after 5 min: leave everything as it was',
      'mv -f "$NEW" "$OLD" && chmod +x "$OLD"',
      'nohup "$OLD" >/dev/null 2>&1 &',
      '',
    ].join('\n'),
    {mode: 0o755},
  )
  detached('/bin/sh', [script, String(ctx.pid), current, staged])
  return 'quit'
}

/** A system package install through the desktop's password prompt (polkit). */
async function elevated(command: string[]): Promise<void> {
  try {
    await run('pkexec', command, {timeout: 10 * 60_000})
  } catch (error) {
    const code = (error as {code?: number}).code
    // 126 / 127: the password prompt was dismissed or not allowed
    throw new UpdateError(
      code === 126 || code === 127
        ? 'The update needs your password to install.'
        : `Installing the update failed: ${String(error)}`,
    )
  }
}

function detached(command: string, args: string[]): void {
  spawn(command, args, {detached: true, stdio: 'ignore'}).unref()
}
