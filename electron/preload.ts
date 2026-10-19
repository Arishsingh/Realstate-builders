/**
 * The only bridge between the UI and the main process. Exposes `window.api` (typed by IpcApi).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { CollectorState, IpcApi, SearchProgress, SenderState } from '../src/shared/types';

const invoke = (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args);

function subscribe<T>(channel: string, cb: (payload: T) => void) {
  const handler = (_e: IpcRendererEvent, payload: T) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
}

const api: IpcApi = {
  search: {
    start: (req) => invoke('search:start', req),
    cancel: (id) => invoke('search:cancel', id),
    onProgress: (cb) => subscribe<SearchProgress>('search:progress', cb),
    list: () => invoke('search:list'),
    sources: () => invoke('search:sources'),
  },
  leads: {
    list: (q) => invoke('leads:list', q),
    update: (id, patch) => invoke('leads:update', id, patch),
    setStatus: (ids, status) => invoke('leads:setStatus', ids, status),
    remove: (ids) => invoke('leads:remove', ids),
    export: (ids, format, meta) => invoke('leads:export', ids, format, meta),
    whatsappLink: (id, templateId) => invoke('leads:whatsapp', id, templateId),
    importCsv: () => invoke('leads:importCsv'),
    add: (input) => invoke('leads:add', input),
    onChanged: (cb) => subscribe<void>('leads:changed', () => cb()),
  },
  templates: {
    list: () => invoke('templates:list'),
    save: (t) => invoke('templates:save', t),
    remove: (id) => invoke('templates:remove', id),
    preview: (templateId, leadId) => invoke('templates:preview', templateId, leadId),
    sendTest: (templateId, leadId) => invoke('templates:sendTest', templateId, leadId),
  },
  campaigns: {
    list: () => invoke('campaigns:list'),
    get: (id) => invoke('campaigns:get', id),
    create: (name, templateId, leadIds) => invoke('campaigns:create', name, templateId, leadIds),
    addLeads: (id, leadIds) => invoke('campaigns:addLeads', id, leadIds),
    update: (id, patch) => invoke('campaigns:update', id, patch),
    remove: (id) => invoke('campaigns:remove', id),
    start: (id) => invoke('campaigns:start', id),
    pause: (id) => invoke('campaigns:pause', id),
    senderState: () => invoke('campaigns:senderState'),
    onSenderState: (cb) => subscribe<SenderState>('campaigns:senderState', cb),
  },
  settings: {
    get: () => invoke('settings:get'),
    update: (patch) => invoke('settings:update', patch),
    testPlacesKey: () => invoke('settings:testPlacesKey'),
    testSmtp: (to) => invoke('settings:testSmtp', to),
  },
  rera: {
    importCsv: () => invoke('rera:import'),
    stats: () => invoke('rera:stats'),
    clear: () => invoke('rera:clear'),
  },
  collector: {
    open: (mode, location) => invoke('collector:open', mode, location),
    state: () => invoke('collector:state'),
    onState: (cb) => subscribe<CollectorState>('collector:state', cb),
    setMode: (mode, location) => invoke('collector:setMode', mode, location),
    navigate: (url) => invoke('collector:navigate', url),
    nav: (action) => invoke('collector:nav', action),
    readSelection: () => invoke('collector:readSelection'),
    parse: (text) => invoke('collector:parse', text),
    save: (candidates) => invoke('collector:save', candidates),
    importReraPage: () => invoke('collector:importReraPage'),
  },
  shell: {
    openExternal: (url) => invoke('shell:openExternal', url),
    copy: (text) => invoke('shell:copy', text),
  },
};

contextBridge.exposeInMainWorld('api', api);
