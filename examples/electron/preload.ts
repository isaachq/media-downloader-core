// Reference preload: the only surface the renderer gets. Not compiled with the library.
import {contextBridge, type IpcRendererEvent, ipcRenderer} from 'electron'
import type {AnalysisResult, FormatProfile, JobSnapshot} from 'media-downloader-core'

type EnqueueArgs = {token: string; profile: FormatProfile; outDir: string; indexes?: number[]}

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

contextBridge.exposeInMainWorld('downloader', {
  info: (): Promise<{cpus: number; maxConcurrency: number; concurrency: number}> =>
    ipcRenderer.invoke('downloader:info'),
  analyze: (url: string): Promise<{token: string; result: AnalysisResult}> =>
    ipcRenderer.invoke('downloader:analyze', url),
  enqueue: (args: EnqueueArgs): Promise<JobSnapshot[]> => ipcRenderer.invoke('downloader:enqueue', args),
  jobs: (): Promise<JobSnapshot[]> => ipcRenderer.invoke('downloader:jobs'),
  cancel: (id: string) => ipcRenderer.invoke('downloader:cancel', id),
  cancelAll: () => ipcRenderer.invoke('downloader:cancelAll'),
  retry: (id: string) => ipcRenderer.invoke('downloader:retry', id),
  pause: () => ipcRenderer.invoke('downloader:pause'),
  resume: () => ipcRenderer.invoke('downloader:resume'),
  setConcurrency: (n: number): Promise<number> => ipcRenderer.invoke('downloader:setConcurrency', n),
  clearFinished: () => ipcRenderer.invoke('downloader:clearFinished'),
  verifyArchive: () => ipcRenderer.invoke('downloader:verifyArchive'),
  reveal: (filepath: string) => ipcRenderer.invoke('downloader:reveal', filepath),
  chooseFolder: (): Promise<string | undefined> => ipcRenderer.invoke('downloader:chooseFolder'),
  onJob: (listener: (job: JobSnapshot) => void) => subscribe('downloader:job', listener),
  onIdle: (listener: () => void) => subscribe('downloader:idle', listener),
  onLog: (listener: (log: {level: string; message: string}) => void) => subscribe('downloader:log', listener),
})
