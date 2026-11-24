import { contextBridge, ipcRenderer } from 'electron';
import type { AuthState, DesktopApi, UpdateState } from '../shared/types';

const api: DesktopApi = {
  voice: enabled => ipcRenderer.invoke('tai:voice', enabled),
  navigate: url => ipcRenderer.invoke('tai:navigate', url),
  bounds: bounds => ipcRenderer.invoke('tai:bounds', bounds),
  playback: (action, time) => ipcRenderer.invoke('tai:playback', action, time),
  session: () => ipcRenderer.invoke('tai:session'),
  startTranslation: id => ipcRenderer.invoke('tai:start-translation', id),
  loadSubtitles: (id, language, forceRefresh) => ipcRenderer.invoke('tai:load-subtitles', id, language, forceRefresh),
  retry: () => ipcRenderer.invoke('tai:retry'),
  audio: (id, chunk, language) => ipcRenderer.invoke('tai:audio', id, chunk, language),
  settings: () => ipcRenderer.invoke('tai:settings'),
  save: input => ipcRenderer.invoke('tai:save', input),
  status: () => ipcRenderer.invoke('tai:status'),
  openCache: () => ipcRenderer.invoke('tai:open-cache'),
  chooseAudioDirectory: () => ipcRenderer.invoke('tai:choose-audio-directory'),
  checkUpdate: () => ipcRenderer.invoke('tai:check-update'),
  downloadUpdate: () => ipcRenderer.invoke('tai:download-update'),
  installUpdate: () => ipcRenderer.invoke('tai:install-update'),
  onUpdateStatus: listener => {
    const handler = (_event: unknown, state: UpdateState) => listener(state);
    ipcRenderer.on('tai:update-status', handler);
    return () => { ipcRenderer.removeListener('tai:update-status', handler); };
  },
  appVersion: () => ipcRenderer.invoke('tai:app-version'),
  // Realtime v2 APIs
  startDubbing: (videoId, options) => ipcRenderer.invoke('tai:start-dubbing', videoId, options),
  stopDubbing: () => ipcRenderer.invoke('tai:stop-dubbing'),
  setTranscriptOpen: open => ipcRenderer.invoke('tai:set-transcript-open', open),
  synthesizeTts: req => ipcRenderer.invoke('tai:synthesize-tts', req),
  controlVideo: cmd => ipcRenderer.invoke('tai:control-video', cmd),
  updateOverlay: payload => ipcRenderer.invoke('tai:update-overlay', payload),
  getOverlayAnchor: () => ipcRenderer.invoke('tai:get-overlay-anchor'),
  reportSessions: sessions => ipcRenderer.invoke('tai:report-sessions', sessions),
  saveDubbingPrefs: prefs => ipcRenderer.invoke('tai:save-dubbing-prefs', prefs),
  dubbingHealth: () => ipcRenderer.invoke('tai:dubbing-health'),
  // SaaS Auth & Plans APIs
  authState: () => ipcRenderer.invoke('tai:auth-state'),
  authLogin: input => ipcRenderer.invoke('tai:auth-login', input),
  authRegister: input => ipcRenderer.invoke('tai:auth-register', input),
  authLogout: () => ipcRenderer.invoke('tai:auth-logout'),
  refreshEntitlement: () => ipcRenderer.invoke('tai:saas-entitlement'),
  listPublicPlans: () => ipcRenderer.invoke('tai:saas-plans'),
  listUpgradeRequests: () => ipcRenderer.invoke('tai:saas-upgrade-requests'),
  createUpgradeRequest: input => ipcRenderer.invoke('tai:saas-create-upgrade-request', input),
  onAuthState: listener => {
    const handler = (_event: unknown, state: AuthState) => listener(state);
    ipcRenderer.on('tai:auth-state-changed', handler);
    return () => { ipcRenderer.removeListener('tai:auth-state-changed', handler); };
  },
  // SePay Payment APIs
  getPaymentConfig: () => ipcRenderer.invoke('tai:saas-payment-config'),
  createPaymentOrder: input => ipcRenderer.invoke('tai:saas-create-payment-order', input),
  listPaymentOrders: () => ipcRenderer.invoke('tai:saas-payment-orders'),
  getPaymentOrderStatus: paymentCode => ipcRenderer.invoke('tai:saas-payment-order-status', paymentCode),
  cancelPaymentOrder: paymentCode => ipcRenderer.invoke('tai:saas-cancel-payment-order', paymentCode)
};

contextBridge.exposeInMainWorld('tai', api);
