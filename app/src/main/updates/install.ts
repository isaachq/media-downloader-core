import {execFile, spawn} from 'node:child_process'
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

const writable = (dir: string): Promise<boolean> =>
  fs.access(dir, fs.constants.W_OK).then(
    () => true,
    () => false,
  )

/**
 * The PowerShell helper: waits for this process to exit, runs the NSIS
 * installer silently for the same scope — asking for an administrator's
 * permission (the usual Windows prompt) when the install is for everyone and
 * the folder needs it — and writes each step to install.log. When the
 * update does not go in (permission declined, installer failed, the app did
 * not close), it starts the old version again: never a silent dead end.
 */
export function windowsInstallScript(): string {
  return [
    'param([int]$AppPid, [string]$Installer, [string]$AppExe, [string]$Log, [string]$Scope, [int]$Elevate)',
    '# Media Download Core: run the installer once the running copy has quit',
    'function Note([string]$Text) { Add-Content -LiteralPath $Log -Value ((Get-Date).ToString("o") + " " + $Text) }',
    'function Fail([string]$Why) {',
    `  Note "${NOT_INSTALLED} $Why"`,
    '  if (Test-Path -LiteralPath $AppExe) { Start-Process -FilePath $AppExe }',
    '  exit 1',
    '}',
    'Note "waiting for the app (pid $AppPid) to close"',
    'Wait-Process -Id $AppPid -Timeout 120 -ErrorAction SilentlyContinue',
    "if (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) { Fail 'the app did not close' }",
    "$flags = @('/S', '--force-run', $(if ($Scope -eq 'machine') { '/allusers' } else { '/currentuser' }))",
    'Note "installing for $Scope (administrator: $Elevate)"',
    'try {',
    '  if ($Elevate -eq 1) { $p = Start-Process -FilePath $Installer -ArgumentList $flags -Verb RunAs -PassThru }',
    '  else { $p = Start-Process -FilePath $Installer -ArgumentList $flags -PassThru }',
    '  # the process alone, not the app it starts at the end',
    '  $p.WaitForExit()',
    '  if ($p.ExitCode -ne 0) { Fail "the installer ended with code $($p.ExitCode)" }',
    '} catch {',
    '  Fail "the installer did not run: $($_.Exception.Message)"',
    '}',
    "Note 'installed'",
    '',
  ].join('\r\n')
}

/** The NSIS installer, silently and for the same scope, once this process has exited; it starts the new version. */
async function installWindows(ctx: InstallContext): Promise<'quit'> {
  const scope = await windowsScope(ctx.execPath)
  const elevate = scope === 'machine' && !(await writable(path.win32.dirname(ctx.execPath)))
  const script = path.join(ctx.workDir, 'install.ps1')
  await fs.writeFile(script, windowsInstallScript())
  const log = path.join(ctx.workDir, INSTALL_LOG)
  await fs.writeFile(log, `${new Date().toISOString()} update to ${ctx.version}: ${path.basename(ctx.file)}\r\n`)
  // PowerShell's own output (a script it can't run, a parameter it can't bind) goes to a file too
  const output = await fs.open(path.join(ctx.workDir, 'install-helper.log'), 'w')
  try {
    const child = spawn(
      'powershell.exe',
      [
        ...['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script],
        ...['-AppPid', String(ctx.pid), '-Installer', ctx.file, '-AppExe', ctx.execPath],
        ...['-Log', log, '-Scope', scope, '-Elevate', elevate ? '1' : '0'],
      ],
      {detached: true, stdio: ['ignore', output.fd, output.fd], windowsHide: true},
    )
    const started = await new Promise<string>(resolve => {
      child.once('spawn', () => resolve(`helper started (pid ${child.pid})`))
      child.once('error', error => resolve(`${NOT_INSTALLED} the helper could not start: ${error.message}`))
    })
    await fs.appendFile(log, `${new Date().toISOString()} ${started}\r\n`)
    if (started.startsWith(NOT_INSTALLED)) throw new UpdateError(started.slice(NOT_INSTALLED.length).trim())
    child.unref()
  } finally {
    await output.close()
  }
  return 'quit'
}

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
