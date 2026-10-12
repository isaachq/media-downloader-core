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
  analyze: (url, maxItems) => ipcRenderer.invoke(CHANNEL.analyze, url, maxItems),
  cancelAnalyze: () => ipcRenderer.invoke(CHANNEL.analyzeCancel),
  onAnalyzeProgress: listener => subscribe(CHANNEL.analyzeProgress, listener),
  schedule: input => ipcRenderer.invoke(CHANNEL.schedule, input),
  state: () => ipcRenderer.invoke(CHANNEL.state),
  items: (batchId, offset, limit) => ipcRenderer.invoke(CHANNEL.items, batchId, offset, limit),
  cancelBatch: id => ipcRenderer.invoke(CHANNEL.cancelBatch, id),
  cancelJob: id => ipcRenderer.invoke(CHANNEL.cancelJob, id),
  retryJob: id => ipcRenderer.invoke(CHANNEL.retryJob, id),
  retryBatch: id => ipcRenderer.invoke(CHANNEL.retryBatch, id),
  pause: () => ipcRenderer.invoke(CHANNEL.pause),
  resume: () => ipcRenderer.invoke(CHANNEL.resume),
  clearFinished: () => ipcRenderer.invoke(CHANNEL.clearFinished),
  searchLogs: (id, limit) => ipcRenderer.invoke(CHANNEL.searchLogs, id, limit),
  reveal: file => ipcRenderer.invoke(CHANNEL.reveal, file),
  finished: query => ipcRenderer.invoke(CHANNEL.finished, query),
  openFinished: (key, target) => ipcRenderer.invoke(CHANNEL.openFinished, key, target),
  openFolder: target => ipcRenderer.invoke(CHANNEL.openFolder, target),
  finishedGroups: () => ipcRenderer.invoke(CHANNEL.finishedGroups),
  focusWindow: () => ipcRenderer.invoke(CHANNEL.focusWindow),
  verifyFinished: target => ipcRenderer.invoke(CHANNEL.verifyFinished, target),
  onVerifyProgress: listener => subscribe(CHANNEL.verifyProgress, listener),
  removeFinished: keys => ipcRenderer.invoke(CHANNEL.removeFinished, keys),
  exportFinished: target => ipcRenderer.invoke(CHANNEL.exportFinished, target),
  updateState: () => ipcRenderer.invoke(CHANNEL.updateState),
  checkForUpdates: () => ipcRenderer.invoke(CHANNEL.updateCheck),
  installUpdate: () => ipcRenderer.invoke(CHANNEL.updateInstall),
  onUpdate: listener => subscribe(CHANNEL.update, listener),
  onEvents: listener => subscribe(CHANNEL.events, listener),
  onSetupProgress: listener => subscribe(CHANNEL.setupProgress, listener),
}

contextBridge.exposeInMainWorld('mdc', api)
