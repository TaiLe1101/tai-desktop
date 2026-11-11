import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared/types';
const api: DesktopApi = {
  voice: enabled => ipcRenderer.invoke('tai:voice', enabled),
  navigate: url => ipcRenderer.invoke('tai:navigate', url),
  bounds: bounds => ipcRenderer.invoke('tai:bounds', bounds),
  playback: (action, time) => ipcRenderer.invoke('tai:playback', action, time),
  session: () => ipcRenderer.invoke('tai:session'),
  startTranslation: id => ipcRenderer.invoke('tai:start-translation', id),
  loadSubtitles: (id, language) => ipcRenderer.invoke('tai:load-subtitles', id, language),
  retry: () => ipcRenderer.invoke('tai:retry'),
  audio: (id, chunk, language) => ipcRenderer.invoke('tai:audio', id, chunk, language),
  settings: () => ipcRenderer.invoke('tai:settings'),
  save: input => ipcRenderer.invoke('tai:save', input),
  status: () => ipcRenderer.invoke('tai:status'),
  openCache: () => ipcRenderer.invoke('tai:open-cache'),
  chooseAudioDirectory: () => ipcRenderer.invoke('tai:choose-audio-directory')
};
contextBridge.exposeInMainWorld('tai', api);
