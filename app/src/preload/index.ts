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
  analyzeMix: (text, format, quality) => ipcRenderer.invoke(CHANNEL.mixAnalyze, text, format, quality),
  cancelMix: () => ipcRenderer.invoke(CHANNEL.mixCancel),
  onMixProgress: listener => subscribe(CHANNEL.mixProgress, listener),
  scheduleMix: input => ipcRenderer.invoke(CHANNEL.mixSchedule, input),
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
  syncList: () => ipcRenderer.invoke(CHANNEL.syncList),
  syncFolder: folder => ipcRenderer.invoke(CHANNEL.syncFolder, folder),
  syncAdd: input => ipcRenderer.invoke(CHANNEL.syncAdd, input),
  syncUpdate: (id, patch) => ipcRenderer.invoke(CHANNEL.syncUpdate, id, patch),
  syncRemove: id => ipcRenderer.invoke(CHANNEL.syncRemove, id),
  syncRun: (id, deep) => ipcRenderer.invoke(CHANNEL.syncRun, id, deep),
  syncCheck: (id, deep) => ipcRenderer.invoke(CHANNEL.syncCheck, id, deep),
  onSync: listener => subscribe(CHANNEL.syncEvent, listener),
  verifyFinished: target => ipcRenderer.invoke(CHANNEL.verifyFinished, target),
  onVerifyProgress: listener => subscribe(CHANNEL.verifyProgress, listener),
  removeFinished: keys => ipcRenderer.invoke(CHANNEL.removeFinished, keys),
  pruneFinished: target => ipcRenderer.invoke(CHANNEL.pruneFinished, target),
  redownloadFinished: target => ipcRenderer.invoke(CHANNEL.redownloadFinished, target),
  retryFailed: items => ipcRenderer.invoke(CHANNEL.retryFailed, items),
  damagedList: () => ipcRenderer.invoke(CHANNEL.damagedList),
  damagedForget: key => ipcRenderer.invoke(CHANNEL.damagedForget, key),
  relaunch: () => ipcRenderer.invoke(CHANNEL.relaunch),
  exportFinished: target => ipcRenderer.invoke(CHANNEL.exportFinished, target),
  updateState: () => ipcRenderer.invoke(CHANNEL.updateState),
  checkForUpdates: () => ipcRenderer.invoke(CHANNEL.updateCheck),
  installUpdate: () => ipcRenderer.invoke(CHANNEL.updateInstall),
  onUpdate: listener => subscribe(CHANNEL.update, listener),
  onEvents: listener => subscribe(CHANNEL.events, listener),
  youtubeState: () => ipcRenderer.invoke(CHANNEL.youtubeState),
  youtubeSignIn: () => ipcRenderer.invoke(CHANNEL.youtubeSignIn),
  youtubeSignOut: () => ipcRenderer.invoke(CHANNEL.youtubeSignOut),
  youtubeWait: () => ipcRenderer.invoke(CHANNEL.youtubeWait),
  onYouTube: listener => subscribe(CHANNEL.youtube, listener),
  onSetupProgress: listener => subscribe(CHANNEL.setupProgress, listener),
}

contextBridge.exposeInMainWorld('mdc', api)
