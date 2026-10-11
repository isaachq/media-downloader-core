import {contextBridge, type IpcRendererEvent, ipcRenderer} from 'electron'
import {CHANNEL, type MdcApi} from '../shared/contract'

function subscribe<T>(channel: string, listener: (payload: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, payload: T) => listener(payload)
  ipcRenderer.on(channel, handler)
  return () => {
    ipcRenderer.removeListener(channel, handler)
  }
}

// The renderer's only access to the system: a fixed set of typed calls.
const api: MdcApi = {
  info: () => ipcRenderer.invoke(CHANNEL.info),
  getSettings: () => ipcRenderer.invoke(CHANNEL.getSettings),
  setSettings: patch => ipcRenderer.invoke(CHANNEL.setSettings, patch),
  chooseFolder: current => ipcRenderer.invoke(CHANNEL.chooseFolder, current),
  doctor: () => ipcRenderer.invoke(CHANNEL.doctor),
  setup: force => ipcRenderer.invoke(CHANNEL.setup, force),
  schedule: input => ipcRenderer.invoke(CHANNEL.schedule, input),
  state: () => ipcRenderer.invoke(CHANNEL.state),
  items: (batchId, offset, limit) => ipcRenderer.invoke(CHANNEL.items, batchId, offset, limit),
  cancelBatch: id => ipcRenderer.invoke(CHANNEL.cancelBatch, id),
  cancelJob: id => ipcRenderer.invoke(CHANNEL.cancelJob, id),
  retryJob: id => ipcRenderer.invoke(CHANNEL.retryJob, id),
  pause: () => ipcRenderer.invoke(CHANNEL.pause),
  resume: () => ipcRenderer.invoke(CHANNEL.resume),
  clearFinished: () => ipcRenderer.invoke(CHANNEL.clearFinished),
  searchLogs: (id, limit) => ipcRenderer.invoke(CHANNEL.searchLogs, id, limit),
  reveal: file => ipcRenderer.invoke(CHANNEL.reveal, file),
  onEvents: listener => subscribe(CHANNEL.events, listener),
  onSetupProgress: listener => subscribe(CHANNEL.setupProgress, listener),
}

contextBridge.exposeInMainWorld('mdc', api)
