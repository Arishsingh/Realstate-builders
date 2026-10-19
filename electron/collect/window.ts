/**
 * The Collector: a window with a real website on the left (a portal or a state RERA site)
 * and the PropLeads panel on the right. The user browses and solves any CAPTCHA themselves;
 * the app only reads what they select, paste, or the RERA results table they are looking at.
 * It never crawls pages in the background or gets around a CAPTCHA.
 */
import { BaseWindow, ipcMain, shell, WebContentsView, type WebContents } from 'electron';
import type { CollectorMode, CollectorState, ContactCandidate, ReraPageImport } from '../../src/shared/types';
import { portalLinks, RERA_PORTALS } from '../../src/shared/portalLinks';
import * as db from '../db';
import { AppFailure, wrap } from '../errors';
import { dedupeDomain, normalizePhone } from '../normalize';
import { parseContacts, reraTablesToAgents } from './extract';

const PANEL_WIDTH = 400;
/** Logins on Justdial etc. persist between sessions, separate from the app itself. */
const PARTITION = 'persist:collector';

interface Options {
  preload: string;
  loadPanel: (wc: WebContents) => void;
  onLeadsChanged: () => void;
}

let opts: Options;
let win: BaseWindow | null = null;
let site: WebContentsView | null = null;
let panel: WebContentsView | null = null;
let state: CollectorState = { mode: 'portals', location: '', url: '', title: '', canGoBack: false, canGoForward: false, loading: false, added: 0 };
let sessionSearch: { id: number; count: number } | null = null;

function push(patch: Partial<CollectorState> = {}) {
  state = { ...state, ...patch };
  if (site && !site.webContents.isDestroyed()) {
    const wc = site.webContents;
    state.url = wc.getURL();
    state.title = wc.getTitle();
    state.canGoBack = wc.navigationHistory.canGoBack();
    state.canGoForward = wc.navigationHistory.canGoForward();
    state.loading = wc.isLoading();
  }
  if (panel && !panel.webContents.isDestroyed()) panel.webContents.send('collector:state', state);
  win?.setTitle(state.mode === 'rera' ? 'RERA browser — PropLeads' : 'Collect leads — PropLeads');
}

function layout() {
  if (!win || !site || !panel) return;
  const { width, height } = win.getContentBounds();
  site.setBounds({ x: 0, y: 0, width: Math.max(200, width - PANEL_WIDTH), height });
  panel.setBounds({ x: Math.max(200, width - PANEL_WIDTH), y: 0, width: PANEL_WIDTH, height });
}

function startUrl(mode: CollectorMode, location: string) {
  if (mode === 'rera') return RERA_PORTALS[0].url;
  return location.trim() ? portalLinks(location)[0].url : 'https://www.google.com/maps';
}

const isWeb = (url: string) => /^https?:\/\//i.test(url);

function createWindow() {
  win = new BaseWindow({ width: 1440, height: 900, minWidth: 1000, minHeight: 600, backgroundColor: '#0b0d10', title: 'Collect leads — PropLeads' });

  site = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  // Look like a normal Chrome so sites don't serve a "browser not supported" page.
  site.webContents.setUserAgent(site.webContents.getUserAgent().replace(/\s(Electron|propleads)\/\S+/gi, ''));
  // Keep popups (listing pages, "view details") in the same view instead of new windows.
  site.webContents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) site?.webContents.loadURL(url);
    return { action: 'deny' };
  });
  const wc = site.webContents;
  for (const ev of ['did-start-loading', 'did-stop-loading', 'did-navigate', 'did-navigate-in-page', 'page-title-updated'] as const) {
    wc.on(ev as 'did-stop-loading', () => push());
  }
  wc.session.on('will-download', (e) => e.preventDefault());

  panel = new WebContentsView({ webPreferences: { preload: opts.preload, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  panel.webContents.on('will-navigate', (e) => e.preventDefault());
  panel.webContents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  opts.loadPanel(panel.webContents);

  win.contentView.addChildView(site);
  win.contentView.addChildView(panel);
  layout();
  win.on('resize', layout);
  win.on('closed', () => {
    site?.webContents.close();
    panel?.webContents.close();
    win = site = panel = null;
    sessionSearch = null;
    state = { ...state, added: 0 };
  });
}

export function openCollector(mode: CollectorMode, location: string) {
  const fresh = !win;
  if (!win) createWindow();
  const changed = fresh || mode !== state.mode || (location.trim() && location.trim() !== state.location);
  state = { ...state, mode, location: location.trim() || state.location };
  if (changed) site!.webContents.loadURL(startUrl(mode, state.location));
  push();
  win!.show();
  win!.focus();
}

/** Every table on the page, in every frame, as rows of cell text. */
async function pageTables(): Promise<string[][][]> {
  const js = `[...document.querySelectorAll('table')].map(t => [...t.rows].map(r => [...r.cells].map(c => (c.innerText || '').replace(/\\s+/g, ' ').trim())))`;
  const frames = site!.webContents.mainFrame.framesInSubtree;
  const results = await Promise.all(frames.map((f) => f.executeJavaScript(js).catch(() => [])));
  return results.flat() as string[][][];
}

/** The user's current text selection, from whichever frame has one. */
async function selectionText(): Promise<string> {
  for (const f of site!.webContents.mainFrame.framesInSubtree) {
    const t = String((await f.executeJavaScript('String(window.getSelection() || "")').catch(() => '')) ?? '');
    if (t.trim()) return t;
  }
  return '';
}

function session(label: string) {
  if (!sessionSearch) sessionSearch = { id: db.createSearch(label, 0, []), count: 0 };
  return sessionSearch;
}

function finishSave(added: number) {
  if (!sessionSearch) return;
  sessionSearch.count += added;
  db.finishSearch(sessionSearch.id, sessionSearch.count, 'done');
  push({ added: state.added + added });
  if (added) opts.onLeadsChanged();
}

const str = (v: unknown, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

function saveCandidates(input: unknown): { added: number; duplicates: number } {
  const list = (Array.isArray(input) ? input : []).slice(0, 2000) as Partial<ContactCandidate>[];
  if (!list.length) throw new AppFailure('VALIDATION', 'Nothing to save.');
  const host = (() => {
    try {
      return new URL(state.url).hostname.replace(/^www\./, '');
    } catch {
      return 'a website';
    }
  })();
  const s = session(`Collected · ${state.location || host}`);
  let added = 0;
  let duplicates = 0;
  for (const c of list) {
    const businessName = str(c.businessName, 150);
    const phone = normalizePhone(str(c.phoneRaw) ?? str(c.phone));
    const emailRaw = str(c.email)?.toLowerCase() ?? null;
    const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;
    const websiteRaw = str(c.website, 500);
    const website = websiteRaw ? (isWeb(websiteRaw) ? websiteRaw : `https://${websiteRaw}`) : null;
    if (!businessName || (!phone && !email && !website)) continue;
    const domain = dedupeDomain(website);
    if (db.findDuplicate({ phone: phone?.e164 ?? null, email, domain })) {
      duplicates++;
      continue;
    }
    db.insertLead({
      businessName,
      name: str(c.name, 100),
      phoneRaw: str(c.phoneRaw),
      phone: phone?.e164 ?? null,
      phoneType: phone?.type ?? 'unknown',
      email,
      website,
      domain,
      address: str(c.address, 300),
      reraNumber: str(c.reraNumber, 60) ?? db.findReraAgent({ phone: phone?.e164, email, name: businessName })?.regNumber ?? null,
      locationQuery: state.location || null,
      notes: `From ${host}`,
      source: 'collector',
      sources: ['collector'],
      searchId: s.id,
    });
    added++;
  }
  finishSave(added);
  return { added, duplicates };
}

/** The district / pincode chosen in the portal's search form, for result tables that don't list it per row. */
async function searchedPlace(): Promise<string | null> {
  const js = `[...document.querySelectorAll('select, input')].filter(e => /district|location|pincode|city/i.test(e.name || e.id || '')).map(e => e.tagName === 'SELECT' ? (e.selectedIndex > 0 ? e.selectedOptions[0].text : '') : e.value).map(v => (v || '').trim()).filter(Boolean)`;
  const frames = site!.webContents.mainFrame.framesInSubtree;
  const values = (await Promise.all(frames.map((f) => f.executeJavaScript(js).catch(() => [])))).flat() as string[];
  return values.length ? [...new Set(values)].join(', ') : null;
}

async function importReraPage(): Promise<ReraPageImport> {
  const result = reraTablesToAgents(await pageTables());
  const place = await searchedPlace();
  if (result && place) for (const a of result.agents) a.district ??= place;
  if (!result?.agents.length) {
    throw new AppFailure(
      'VALIDATION',
      "No agents table on this page. Search for agents on the portal first (solve the CAPTCHA), wait for the results list, then press Import this page. If the results aren't a table, select them and use Add from selection.",
    );
  }
  db.upsertReraAgents(result.agents);
  const tagged = db.tagLeadsWithRera();
  const known = db.knownPlaceIds();
  const s = session(`RERA browser · ${state.location || 'agents'}`);
  let addedLeads = 0;
  let duplicates = 0;
  for (const a of result.agents) {
    const placeId = `rera:${a.regNumber}`;
    if (known.has(placeId) || db.findDuplicate({ phone: a.phone, email: a.email })) {
      duplicates++;
      continue;
    }
    db.insertLead({
      placeId,
      businessName: a.businessName || a.name || a.regNumber,
      name: a.businessName ? a.name : null,
      phone: a.phone,
      phoneType: a.phone ? normalizePhone(a.phone)?.type ?? 'unknown' : 'unknown',
      email: a.email,
      address: [a.address, a.district, a.state].filter(Boolean).join(', ') || null,
      reraNumber: a.regNumber,
      locationQuery: state.location || a.district || null,
      source: 'rera',
      sources: ['rera'],
      searchId: s.id,
    });
    known.add(placeId);
    addedLeads++;
  }
  finishSave(addedLeads);
  return { agents: result.agents.length, addedLeads, duplicates, tagged, skipped: result.skipped };
}

export function initCollector(o: Options) {
  opts = o;
  ipcMain.handle('collector:open', (_e, mode: CollectorMode, location: string) => openCollector(mode === 'rera' ? 'rera' : 'portals', String(location ?? '')));
  ipcMain.handle('collector:setMode', (_e, mode: CollectorMode, location: string) => openCollector(mode === 'rera' ? 'rera' : 'portals', String(location ?? '')));
  ipcMain.handle('collector:state', () => state);
  ipcMain.handle('collector:navigate', (_e, url: string) => {
    if (site && typeof url === 'string' && isWeb(url)) site.webContents.loadURL(url);
  });
  ipcMain.handle('collector:nav', (_e, action: string) => {
    const wc = site?.webContents;
    if (!wc) return;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    if (action === 'reload') wc.reload();
  });
  ipcMain.handle('collector:readSelection', async () => (site ? parseContacts(await selectionText()) : []));
  ipcMain.handle('collector:parse', (_e, text: string) => parseContacts(String(text ?? '')));
  ipcMain.handle('collector:save', (_e, list: unknown) => wrap(() => saveCandidates(list)));
  ipcMain.handle('collector:importReraPage', () => wrap(() => importReraPage()));
}
