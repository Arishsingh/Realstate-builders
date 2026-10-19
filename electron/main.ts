/**
 * Electron main process. All network work (Places API, website fetching, SMTP) and the
 * database live here. The renderer reaches it only through the typed API in preload.ts.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import type { ExportFormat, ExportMeta, LeadQuery, LeadStatus, SearchRequest, SettingsUpdate } from '../src/shared/types';
import { LEAD_STATUSES } from '../src/shared/types';
import * as db from './db';
import { wrap } from './errors';
import { writeExport } from './export';
import { writePdf } from './exportPdf';
import { checkEmails } from './enrich/verifyEmail';
import { whatsappUrl } from './normalize';
import { ensureLoop, onSenderState, pauseCampaign, sendPreview, senderState, startCampaign, testSmtp } from './outreach/mailer';
import { composeEmail, render } from './outreach/template';
import { cancelSearch, runSearch } from './search';
import { getSettings, updateSettings } from './settings';
import { sourceInfo } from './sources';
import { testPlacesKey } from './sources/googlePlaces';
import { importReraFile } from './sources/rera';
import { parseLeadCsv } from './leadCsv';
import fs from 'node:fs';
import { Deduper, isSharedHost, normalizePhone } from './normalize';
import { AppFailure } from './errors';
import { initCollector } from './collect/window';
import { belongsToSite, tidyEmail } from './enrich/emails';

const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i;

/** "sales@acme-homes.co.in" → "Acme Homes", used when a lead is added without a business name. */
function nameFromEmail(email: string) {
  const host = email.split('@')[1].split('.')[0];
  return host.replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Manual "Add lead": one row per pasted address. Extra fields apply only when a single address is given. */
function addLeads(input: { emails: string; businessName?: string; name?: string; phone?: string; location?: string }) {
  const emails = [...new Set(String(input.emails ?? '').split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean))];
  const bad = emails.filter((e) => !EMAIL_RE.test(e));
  if (!emails.length) throw new AppFailure('VALIDATION', 'Enter at least one email address.');
  if (bad.length) throw new AppFailure('VALIDATION', `Not an email address: ${bad.slice(0, 3).join(', ')}`);
  const single = emails.length === 1;
  let added = 0;
  let duplicates = 0;
  for (const email of emails) {
    const phone = single ? normalizePhone(input.phone) : null;
    if (db.findDuplicate({ email, phone: phone?.e164 ?? null })) {
      duplicates++;
      continue;
    }
    db.insertLead({
      businessName: (single && input.businessName?.trim()) || nameFromEmail(email),
      name: (single && input.name?.trim()) || null,
      email,
      phoneRaw: single ? input.phone?.trim() || null : null,
      phone: phone?.e164 ?? null,
      phoneType: phone?.type ?? 'unknown',
      locationQuery: (single && input.location?.trim()) || null,
      address: (single && input.location?.trim()) || null,
      source: 'manual',
      sources: ['manual'],
    });
    added++;
  }
  return { added, duplicates };
}

let win: BrowserWindow | null = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 600,
    title: 'PropLeads',
    backgroundColor: '#0b0d10',
    // The topbar leaves room for the traffic lights and acts as the drag region.
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Never open new Electron windows; send links to the system browser instead.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('http://localhost:5173') && !url.startsWith('file://')) e.preventDefault();
  });

  if (process.env.VITE_DEV_SERVER_URL) win.loadURL(process.env.VITE_DEV_SERVER_URL);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  win.on('closed', () => (win = null));
}

const send = (channel: string, payload: unknown) => win?.webContents.send(channel, payload);

/**
 * Checks every email that hasn't been checked yet (new leads from searches, imports, the Collector).
 * Runs one batch at a time; a request while one is running queues exactly one more run.
 */
let verifying: Promise<void> | null = null;
let verifyAgain = false;
function verifyPendingEmails() {
  if (verifying) {
    verifyAgain = true;
    return;
  }
  verifying = (async () => {
    const pending = db.leadsNeedingEmailCheck();
    if (!pending.length) return;
    const results = await checkEmails(pending.map((p) => p.email));
    for (const p of pending) db.setEmailStatus(p.id, results.get(p.email.toLowerCase()) ?? 'unknown');
    send('leads:changed', null);
  })()
    .catch(() => undefined)
    .finally(() => {
      verifying = null;
      if (verifyAgain) {
        verifyAgain = false;
        verifyPendingEmails();
      }
    });
}

function whatsappFor(leadId: number, templateId?: number | null) {
  const lead = db.getLead(leadId);
  if (!lead?.phone) return null;
  const tpl = templateId ? db.getTemplate(templateId) : null;
  const message = tpl ? render(tpl.body, lead).trim() : `Hi ${lead.name || lead.businessName}, `;
  return whatsappUrl(lead.phone, message);
}

const ids = (v: unknown): number[] => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isInteger(n) && n > 0) : []);

function registerIpc() {
  // Search
  ipcMain.handle('search:start', (_e, req: SearchRequest) =>
    wrap(async () => {
      try {
        return await runSearch(req, (p) => send('search:progress', p));
      } finally {
        verifyPendingEmails();
      }
    }),
  );
  ipcMain.handle('search:cancel', (_e, id?: number) => cancelSearch(id));
  ipcMain.handle('search:list', () => db.listSearches());
  ipcMain.handle('search:sources', () => sourceInfo());

  // Leads
  ipcMain.handle('leads:list', (_e, q?: LeadQuery) => db.listLeads(q ?? {}));
  ipcMain.handle('leads:update', (_e, id: number, patch: { status?: LeadStatus; notes?: string | null; name?: string | null; email?: string | null }) => {
    if (patch.status && !LEAD_STATUSES.includes(patch.status)) return db.getLead(id);
    const email = patch.email === undefined ? undefined : patch.email?.trim().toLowerCase() || null;
    const lead = db.updateLead(id, { status: patch.status, notes: patch.notes, name: patch.name, email, allEmails: email ? [email] : undefined });
    if (email) verifyPendingEmails();
    return lead;
  });
  ipcMain.handle('leads:setStatus', (_e, list: number[], status: LeadStatus) => (LEAD_STATUSES.includes(status) ? db.setLeadStatus(ids(list), status) : 0));
  ipcMain.handle('leads:remove', (_e, list: number[]) => db.deleteLeads(ids(list)));
  ipcMain.handle('leads:export', (_e, list: number[], format: ExportFormat, meta?: ExportMeta) =>
    wrap(async () => {
      // Keep the order the user sees in the table.
      const byId = new Map(db.getLeads(ids(list)).map((l) => [l.id, l]));
      const leads = ids(list).map((id) => byId.get(id)).filter((l) => l !== undefined);
      if (format === 'pdf') {
        const stamp = new Date().toISOString().slice(0, 10);
        const { canceled, filePath } = await dialog.showSaveDialog(win!, {
          title: 'Download PDF',
          defaultPath: path.join(app.getPath('downloads'), `real-estate-agents-${stamp}.pdf`),
          filters: [{ name: 'PDF', extensions: ['pdf'] }],
        });
        if (canceled || !filePath) return { saved: false };
        await writePdf(leads, filePath, { title: String(meta?.title ?? '').slice(0, 120) || undefined, filters: String(meta?.filters ?? '').slice(0, 300) || undefined });
        return { saved: true, filePath };
      }
      const ext = format === 'xlsx' ? 'xlsx' : 'csv';
      const stamp = new Date().toISOString().slice(0, 10);
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: 'Export leads',
        defaultPath: path.join(app.getPath('downloads'), `propleads-${stamp}.${ext}`),
        filters: [ext === 'xlsx' ? { name: 'Excel', extensions: ['xlsx'] } : { name: 'CSV', extensions: ['csv'] }],
      });
      if (canceled || !filePath) return { saved: false };
      await writeExport(leads, filePath, ext);
      return { saved: true, filePath };
    }),
  );
  ipcMain.handle('leads:importCsv', () =>
    wrap(async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
        title: 'Import leads (CSV)',
        properties: ['openFile'],
        filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      });
      if (canceled || !filePaths[0]) return null;
      const { leads, skipped, columns } = parseLeadCsv(fs.readFileSync(filePaths[0], 'utf8'));
      const label = `Imported: ${path.basename(filePaths[0])}`;
      const searchId = db.createSearch(label, leads.length, []);
      const seen = new Deduper();
      let imported = 0;
      let duplicates = 0;
      for (const l of leads) {
        const keys = { phone: l.phone, email: l.email, domain: l.domain };
        if (!seen.add(keys) || db.findDuplicate(keys)) {
          duplicates++;
          continue;
        }
        db.insertLead({ ...l, source: 'csv_import', sources: ['csv_import'], locationQuery: null, searchId });
        imported++;
      }
      db.finishSearch(searchId, imported, 'done');
      const tagged = db.tagLeadsWithRera();
      verifyPendingEmails();
      return { imported, duplicates, skipped, tagged, searchId, columns };
    }),
  );
  ipcMain.handle('leads:add', (_e, input) =>
    wrap(() => {
      const r = addLeads(input ?? {});
      verifyPendingEmails();
      return r;
    }),
  );
  ipcMain.handle('leads:whatsapp', (_e, id: number, templateId?: number | null) => whatsappFor(id, templateId));

  // Templates
  ipcMain.handle('templates:list', () => db.listTemplates());
  ipcMain.handle('templates:save', (_e, t: { id?: number; name: string; subject: string; body: string }) =>
    db.saveTemplate({ id: t.id, name: String(t.name || 'Untitled').slice(0, 100), subject: String(t.subject ?? ''), body: String(t.body ?? '') }),
  );
  ipcMain.handle('templates:remove', (_e, id: number) => db.deleteTemplate(id));
  ipcMain.handle('templates:preview', (_e, templateId: number, leadId: number) => {
    const tpl = db.getTemplate(templateId);
    const lead = db.getLead(leadId);
    return tpl && lead ? composeEmail(tpl, lead, getSettings().senderFooter) : null;
  });
  ipcMain.handle('templates:sendTest', (_e, templateId: number, leadId: number) =>
    wrap(async () => {
      const tpl = db.getTemplate(templateId);
      const lead = db.getLead(leadId);
      if (!tpl || !lead) throw new AppFailure('VALIDATION', 'Pick a template and a lead to preview first.');
      const { subject, text } = composeEmail(tpl, lead, getSettings().senderFooter);
      return { message: await sendPreview(subject, text) };
    }),
  );

  // Campaigns
  ipcMain.handle('campaigns:list', () => db.listCampaigns());
  ipcMain.handle('campaigns:get', (_e, id: number) =>
    db.getCampaignDetail(id, (l) => (l.phone ? whatsappFor(l.id, db.getCampaign(id)?.templateId) : null)),
  );
  ipcMain.handle('campaigns:create', (_e, name: string, templateId: number | null, leadIds: number[]) => {
    const c = db.createCampaign(String(name || 'Untitled campaign').slice(0, 100), templateId);
    db.addCampaignLeads(c.id, ids(leadIds));
    return db.getCampaign(c.id);
  });
  ipcMain.handle('campaigns:addLeads', (_e, id: number, leadIds: number[]) => db.addCampaignLeads(id, ids(leadIds)));
  ipcMain.handle('campaigns:update', (_e, id: number, patch: { name?: string; templateId?: number | null }) => db.updateCampaign(id, patch));
  ipcMain.handle('campaigns:remove', (_e, id: number) => {
    pauseCampaign(id);
    db.deleteCampaign(id);
  });
  ipcMain.handle('campaigns:start', (_e, id: number) => wrap(() => startCampaign(id)));
  ipcMain.handle('campaigns:pause', (_e, id: number) => pauseCampaign(id));
  ipcMain.handle('campaigns:senderState', () => senderState());

  // Settings
  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:update', (_e, patch: SettingsUpdate) =>
    wrap(() => {
      const s = updateSettings(patch);
      ensureLoop(); // a raised daily cap or new SMTP password may unblock sending
      return s;
    }),
  );
  ipcMain.handle('settings:testPlacesKey', () => wrap(async () => ({ message: await testPlacesKey() })));
  ipcMain.handle('settings:testSmtp', (_e, to?: string) => wrap(async () => ({ message: await testSmtp(to) })));

  // RERA
  ipcMain.handle('rera:import', () =>
    wrap(async () => {
      const { canceled, filePaths } = await dialog.showOpenDialog(win!, {
        title: 'Import RERA registered agents (CSV)',
        properties: ['openFile'],
        filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
      });
      if (canceled || !filePaths[0]) return null;
      return importReraFile(filePaths[0]);
    }),
  );
  ipcMain.handle('rera:stats', () => db.reraStats());
  ipcMain.handle('rera:clear', () => db.clearRera());

  // Shell helpers
  ipcMain.handle('shell:openExternal', (_e, url: string) => {
    if (typeof url === 'string' && /^(https?:\/\/|mailto:)/i.test(url)) return shell.openExternal(url);
  });
  ipcMain.handle('shell:copy', (_e, text: string) => clipboard.writeText(String(text ?? '')));
}

app.whenReady().then(() => {
  db.openDb(path.join(app.getPath('userData'), 'propleads.db'));
  // Drops theme/platform addresses picked up by older versions; a platform page (Magicpin…) isn't the agent's site.
  db.cleanEnrichedEmails((email, domain) => belongsToSite(email, isSharedHost(domain) ? null : domain), tidyEmail);
  onSenderState((s) => send('campaigns:senderState', s));
  registerIpc();
  initCollector({
    preload: path.join(__dirname, 'preload.cjs'),
    loadPanel: (wc) => {
      if (process.env.VITE_DEV_SERVER_URL) wc.loadURL(`${process.env.VITE_DEV_SERVER_URL}#collector`);
      else wc.loadFile(path.join(__dirname, '..', 'dist', 'index.html'), { hash: 'collector' });
    },
    onLeadsChanged: () => {
      send('leads:changed', null);
      verifyPendingEmails();
    },
  });
  createWindow();
  ensureLoop(); // resume campaigns that were running when the app was closed
  verifyPendingEmails(); // emails saved before verification existed, or checked while offline

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => cancelSearch());
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
