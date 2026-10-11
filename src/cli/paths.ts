import * as os from 'node:os'
import * as path from 'node:path'

/**
 * Same folder Electron uses for `app.getPath('userData')` with productName
 * "Media Download Core", so the CLI and the desktop app share installed
 * tools, the download archive and the trace logs.
 */
export const APP_NAME = 'Media Download Core'

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env['MDC_DATA_DIR']) return path.resolve(env['MDC_DATA_DIR'])
  const home = os.homedir()
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', APP_NAME)
  if (platform === 'win32') return path.join(env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming'), APP_NAME)
  return path.join(env['XDG_CONFIG_HOME'] ?? path.join(home, '.config'), APP_NAME)
}

export function defaultDownloadDir(): string {
  return path.join(os.homedir(), 'Downloads')
}
