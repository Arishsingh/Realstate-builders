/**
 * PDF export: a printable list of leads (name, phone, email, area, website) that can be sent to
 * someone as is. Rendered as HTML in a hidden window and printed with Chromium's own PDF engine.
 */
import { BrowserWindow } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ExportMeta, Lead } from '../src/shared/types';

const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const SOURCE: Record<string, string> = {
  google_places: 'Google',
  maps_browser: 'Google Maps',
  rera: 'RERA',
  reale: 'reale.in',
  csv_import: 'CSV import',
  manual: 'Added by hand',
  collector: 'Collected',
};

/** Spaces a +91 number for reading: +91 98220 12345. */
function prettyPhone(l: Lead) {
  const p = l.phone ?? l.phoneRaw ?? '';
  const m = /^\+91(\d{5})(\d{5})$/.exec(p);
  return m ? `+91 ${m[1]} ${m[2]}` : p;
}

const site = (url: string | null) => (url ? url.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '').split('?')[0] : '');

export function leadsPdfHtml(leads: Lead[], meta: ExportMeta = {}, now = new Date()): string {
  const date = now.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });
  const verified = leads.filter((l) => l.emailStatus === 'verified').length;
  const withPhone = leads.filter((l) => l.phone).length;
  const sources = [...new Set(leads.flatMap((l) => l.sources))].map((s) => SOURCE[s] ?? s).join(', ');

  const rows = leads
    .map(
      (l, i) => `<tr>
  <td class="n">${i + 1}</td>
  <td><b>${esc(l.businessName)}</b>${l.name ? `<div class="sub">${esc(l.name)}</div>` : ''}${l.reraNumber ? `<div class="sub">RERA ${esc(l.reraNumber)}</div>` : ''}</td>
  <td class="mono">${esc(prettyPhone(l)) || '—'}${l.phone ? `<div class="sub">${esc(l.phoneType === 'mobile' ? 'mobile' : l.phoneType === 'landline' ? 'landline' : '')}</div>` : ''}</td>
  <td class="mono">${l.email ? `<a href="mailto:${esc(l.email)}">${esc(l.email)}</a>${l.emailStatus === 'verified' ? '<div class="ok">✓ verified</div>' : ''}` : '—'}</td>
  <td class="addr">${esc(l.address ?? l.locationQuery ?? '')}</td>
  <td>${l.website ? `<a href="${esc(l.website)}">${esc(site(l.website))}</a>` : '—'}</td>
</tr>`,
    )
    .join('\n');

  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.title ?? 'Real estate agents')}</title>
<style>
  @page { size: A4 landscape; margin: 14mm 12mm 16mm; }
  * { box-sizing: border-box; }
  body { font: 10.5px/1.45 -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #111; margin: 0; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .meta { color: #555; font-size: 11px; margin-bottom: 4px; }
  .summary { display: flex; gap: 18px; margin: 10px 0 12px; font-size: 11px; }
  .summary b { font-size: 15px; display: block; color: #111; }
  .summary div { color: #555; }
  table { width: 100%; border-collapse: collapse; }
  thead { display: table-header-group; }
  th { text-align: left; font-size: 9.5px; text-transform: uppercase; letter-spacing: .04em; color: #555; border-bottom: 1.5px solid #111; padding: 6px 6px; }
  td { padding: 6px; border-bottom: 1px solid #ddd; vertical-align: top; word-break: break-word; }
  tr { page-break-inside: avoid; }
  tr:nth-child(even) td { background: #f6f7f9; }
  td.n { color: #888; width: 26px; }
  .mono { font-family: "SF Mono", Menlo, Consolas, monospace; font-size: 10px; }
  .sub { color: #666; font-size: 9.5px; font-family: -apple-system, Helvetica, Arial, sans-serif; }
  .ok { color: #12804f; font-size: 9.5px; font-family: -apple-system, Helvetica, Arial, sans-serif; }
  .addr { color: #333; }
  a { color: #1d4ed8; text-decoration: none; }
  .note { margin-top: 14px; color: #666; font-size: 9.5px; line-height: 1.6; border-top: 1px solid #ddd; padding-top: 8px; }
</style></head><body>
<h1>${esc(meta.title ?? 'Real estate agents')}</h1>
<div class="meta">${esc(date)}${meta.filters ? ` · ${esc(meta.filters)}` : ''}</div>
<div class="summary">
  <div><b>${leads.length}</b>agents</div>
  <div><b>${withPhone}</b>with phone</div>
  <div><b>${verified}</b>verified emails</div>
</div>
<table>
  <thead><tr><th>#</th><th style="width:21%">Agent</th><th style="width:12%">Phone</th><th style="width:22%">Email</th><th>Area / address</th><th style="width:14%">Website</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6">No agents.</td></tr>'}</tbody>
</table>
<div class="note">
  Sources: ${esc(sources || '—')}. Names, phone numbers and addresses are as listed by each business on Google Maps; emails are as published on the agent's own website.
  Phone numbers are checked to be valid Indian numbers (mobile or landline); they have not been called.
  “Verified” emails have a domain that is set up to receive mail; the individual mailbox has not been tested.
</div>
</body></html>`;
}

export async function writePdf(leads: Lead[], filePath: string, meta: ExportMeta = {}) {
  const tmp = path.join(os.tmpdir(), `propleads-export-${process.pid}-${Date.now()}.html`);
  fs.writeFileSync(tmp, leadsPdfHtml(leads, meta), 'utf8');
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  try {
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({
      landscape: true,
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="font-size:8px;color:#888;width:100%;padding:0 12mm;display:flex;justify-content:space-between"><span>PropLeads</span><span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>',
    });
    fs.writeFileSync(filePath, pdf);
  } finally {
    win.destroy();
    fs.rmSync(tmp, { force: true });
  }
}
