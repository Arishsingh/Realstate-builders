/** CSV and Excel export of leads. */
import ExcelJS from 'exceljs';
import fs from 'node:fs';
import type { Lead } from '../src/shared/types';
import { whatsappUrl } from './normalize';

const COLUMNS: { header: string; width: number; get: (l: Lead) => string | number | null }[] = [
  { header: 'Name', width: 22, get: (l) => l.name },
  { header: 'Business Name', width: 32, get: (l) => l.businessName },
  { header: 'Phone', width: 16, get: (l) => l.phone ?? l.phoneRaw },
  { header: 'Phone Type', width: 11, get: (l) => (l.phone ? l.phoneType : null) },
  { header: 'Email', width: 28, get: (l) => l.email },
  { header: 'Email Verified', width: 12, get: (l) => (l.email ? (l.emailStatus === 'verified' ? 'yes' : l.emailStatus === 'invalid' ? 'no' : 'not checked') : null) },
  { header: 'Other Emails', width: 28, get: (l) => l.allEmails.filter((e) => e !== l.email).join('; ') || null },
  { header: 'Website', width: 30, get: (l) => l.website },
  { header: 'Address', width: 40, get: (l) => l.address },
  { header: 'Rating', width: 8, get: (l) => l.rating },
  { header: 'Reviews', width: 8, get: (l) => l.ratingCount },
  { header: 'RERA Number', width: 18, get: (l) => l.reraNumber },
  { header: 'Status', width: 14, get: (l) => l.status },
  { header: 'Source', width: 14, get: (l) => l.sources.join(', ') },
  { header: 'Search Location', width: 20, get: (l) => l.locationQuery },
  { header: 'Property Types', width: 20, get: (l) => l.propertyTypes.join(', ') || null },
  { header: 'Google Maps', width: 30, get: (l) => l.mapsUrl },
  { header: 'WhatsApp Link', width: 30, get: (l) => (l.phoneType === 'mobile' ? whatsappUrl(l.phone) : null) },
  { header: 'Date Found', width: 20, get: (l) => l.createdAt },
  { header: 'Notes', width: 30, get: (l) => l.notes },
];

const csvCell = (v: string | number | null) => {
  if (v === null || v === undefined) return '';
  let s = String(v);
  // Prevent spreadsheet formula injection from scraped text.
  if (/^[=+\-@\t\r]/.test(s) && !/^\+\d/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function leadsToCsv(leads: Lead[]): string {
  const lines = [COLUMNS.map((c) => csvCell(c.header)).join(',')];
  for (const l of leads) lines.push(COLUMNS.map((c) => csvCell(c.get(l))).join(','));
  return lines.join('\r\n');
}

export async function writeExport(leads: Lead[], filePath: string, format: 'csv' | 'xlsx') {
  if (format === 'csv') {
    // BOM so Excel opens UTF-8 names correctly.
    fs.writeFileSync(filePath, '﻿' + leadsToCsv(leads), 'utf8');
    return;
  }
  const wb = new ExcelJS.Workbook();
  wb.creator = 'PropLeads';
  wb.created = new Date();
  const ws = wb.addWorksheet('Leads', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.header, width: c.width }));
  for (const l of leads) ws.addRow(Object.fromEntries(COLUMNS.map((c) => [c.header, c.get(l) ?? ''])));
  ws.getRow(1).font = { bold: true };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: COLUMNS.length } };
  for (const key of ['Website', 'Google Maps', 'WhatsApp Link']) {
    const col = ws.getColumn(key);
    col.eachCell((cell, row) => {
      if (row > 1 && typeof cell.value === 'string' && /^https?:\/\//.test(cell.value)) {
        cell.value = { text: cell.value, hyperlink: cell.value };
        cell.font = { color: { argb: 'FF2563EB' }, underline: true };
      }
    });
  }
  await wb.xlsx.writeFile(filePath);
}
