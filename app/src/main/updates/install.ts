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

/** The NSIS installer, silently, once this process has exited; it starts the new version itself. */
async function installWindows(ctx: InstallContext): Promise<'quit'> {
  const script = path.join(ctx.workDir, 'install.ps1')
  await fs.writeFile(
    script,
    [
      'param([int]$AppPid, [string]$Installer)',
      '# Media Download Core: run the installer once the running copy has quit',
      'Wait-Process -Id $AppPid -Timeout 300 -ErrorAction SilentlyContinue',
      'if (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) { exit 1 }',
      "Start-Process -FilePath $Installer -ArgumentList '/S', '--force-run'",
      '',
    ].join('\r\n'),
  )
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script]
  detached('powershell.exe', [...args, '-AppPid', String(ctx.pid), '-Installer', ctx.file])
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
