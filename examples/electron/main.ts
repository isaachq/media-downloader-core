// Reference wiring for the Electron main process. Not compiled with the library.
import * as path from 'node:path'
import {app, BrowserWindow, dialog, ipcMain, shell} from 'electron'
import {type AnalysisResult, type FormatProfile, MediaDownloader} from 'media-downloader-core'

/**
 * Binaries shipped with the app (electron-builder "extraResources"):
 *
 *   resources/bin/darwin/{yt-dlp/yt-dlp_macos, ffmpeg, ffprobe}
 *   resources/bin/win32/{yt-dlp/yt-dlp.exe, ffmpeg.exe, ffprobe.exe}
 *
 * yt-dlp is the onedir build (folder with _internal/), which starts ~40×
 * faster than the single-file one. Keep ffmpeg and ffprobe in the same folder:
 * yt-dlp looks for ffprobe next to the ffmpeg it is given.
 */
function bundledBinaries() {
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', process.platform)
    : path.join(__dirname, '..', 'resources', 'bin', process.platform)
  const exe = process.platform === 'win32' ? '.exe' : ''
  return {
    ytDlp: path.join(dir, 'yt-dlp', process.platform === 'darwin' ? 'yt-dlp_macos' : `yt-dlp${exe}`),
    ffmpeg: path.join(dir, `ffmpeg${exe}`),
    ffprobe: path.join(dir, `ffprobe${exe}`),
  }
}

const downloader = new MediaDownloader({
  dataDir: app.getPath('userData'),
  binaries: bundledBinaries(),
  validation: 'full',
})

let win: BrowserWindow | undefined
const analyses = new Map<string, AnalysisResult>()

// every job change → renderer (already throttled to 4/s per job by the library)
downloader.on('job', snapshot => win?.webContents.send('downloader:job', snapshot))
downloader.on('idle', () => win?.webContents.send('downloader:idle'))
downloader.on('log', (level, message) => win?.webContents.send('downloader:log', {level, message}))

ipcMain.handle('downloader:info', () => ({
  cpus: MediaDownloader.cpuCount(),
  maxConcurrency: MediaDownloader.maxConcurrency(),
  concurrency: downloader.concurrency,
}))

ipcMain.handle('downloader:analyze', async (_event, url: string) => {
  const result = await downloader.analyze(url)
  const token = crypto.randomUUID()
  analyses.set(token, result) // the renderer refers to it by token, no need to send it back
  return {token, result}
})

ipcMain.handle(
  'downloader:enqueue',
  (_event, args: {token: string; profile: FormatProfile; outDir: string; indexes?: number[]}) => {
    const analysis = analyses.get(args.token)
    if (!analysis) throw new Error('Analysis expired, analyze the url again.')
    analyses.delete(args.token)
    return analysis.kind === 'playlist'
      ? downloader.addPlaylist(analysis, args.profile, args.outDir, {indexes: args.indexes})
      : [downloader.addVideo(analysis, args.profile, args.outDir)]
  },
)

ipcMain.handle('downloader:jobs', () => downloader.jobs())
ipcMain.handle('downloader:cancel', (_e, id: string) => downloader.cancel(id))
ipcMain.handle('downloader:cancelAll', () => downloader.cancelAll())
ipcMain.handle('downloader:retry', (_e, id: string) => downloader.retry(id))
ipcMain.handle('downloader:pause', () => downloader.pause())
ipcMain.handle('downloader:resume', () => downloader.resume())
ipcMain.handle('downloader:setConcurrency', (_e, n: number) => downloader.setConcurrency(n))
ipcMain.handle('downloader:clearFinished', () => downloader.clearFinished())
ipcMain.handle('downloader:verifyArchive', () => downloader.verifyArchive())
ipcMain.handle('downloader:reveal', (_e, filepath: string) => shell.showItemInFolder(filepath))
ipcMain.handle('downloader:chooseFolder', async () => {
  const result = await dialog.showOpenDialog(win!, {properties: ['openDirectory', 'createDirectory']})
  return result.canceled ? undefined : result.filePaths[0]
})

app.whenReady().then(async () => {
  win = new BrowserWindow({
    width: 1100,
    height: 760,
    webPreferences: {preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true},
  })
  await win.loadFile('index.html')

  // pick up whatever was pending when the app closed
  await downloader.restoreQueue()
  // YouTube breaks old yt-dlp versions regularly — update in the background
  downloader
    .updateYtDlp()
    .catch(error => win?.webContents.send('downloader:log', {level: 'warn', message: String(error)}))
})

let quitting = false
app.on('before-quit', event => {
  if (quitting) return
  event.preventDefault()
  quitting = true
  // saves the pending queue, kills yt-dlp/ffmpeg trees, removes temp files
  void downloader.dispose().finally(() => app.quit())
})
