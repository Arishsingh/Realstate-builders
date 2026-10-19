/**
 * Parsing for RERA agent lists (CSV exports, or tables read from a portal page).
 * Kept free of the database so it can be unit-tested and reused by the Collector.
 */
import Papa from 'papaparse';
import type { ReraAgent } from '../db';
import { normalizePhone } from '../normalize';

/** Header names seen in RERA exports, matched case/space-insensitively. */
const COLUMN_ALIASES: Record<keyof ReraAgent, string[]> = {
  regNumber: ['registrationnumber', 'registrationno', 'regno', 'reranumber', 'rerano', 'certificateno', 'agentregistrationnumber', 'registration'],
  name: ['name', 'agentname', 'nameofagent', 'promotername', 'applicantname'],
  businessName: ['firmname', 'businessname', 'companyname', 'organisationname', 'organizationname', 'firm'],
  phone: ['phone', 'mobile', 'mobileno', 'phoneno', 'contactno', 'contactnumber', 'telephone'],
  email: ['email', 'emailid', 'emailaddress', 'mail'],
  address: ['address', 'officeaddress', 'fulladdress', 'location'],
  district: ['district', 'city', 'taluka'],
  state: ['state'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function detectColumns(headers: string[]): Record<keyof ReraAgent, string | null> {
  const out = {} as Record<keyof ReraAgent, string | null>;
  for (const [field, aliases] of Object.entries(COLUMN_ALIASES) as [keyof ReraAgent, string[]][]) {
    out[field] =
      headers.find((h) => aliases.includes(norm(h))) ?? headers.find((h) => aliases.some((a) => a.length > 4 && norm(h).includes(a))) ?? null;
  }
  return out;
}

export function parseReraCsv(text: string) {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? [];
  const cols = detectColumns(headers);
  if (!cols.regNumber) {
    throw new Error(`Couldn't find a registration-number column. Columns found: ${headers.join(', ') || '(none)'}`);
  }
  const agents: ReraAgent[] = [];
  let skipped = 0;
  for (const row of parsed.data) {
    const get = (k: keyof ReraAgent) => {
      const c = cols[k];
      const v = c ? String(row[c] ?? '').trim() : '';
      return v || null;
    };
    const regNumber = get('regNumber');
    if (!regNumber) {
      skipped++;
      continue;
    }
    const email = get('email')?.toLowerCase() ?? null;
    agents.push({
      regNumber,
      name: get('name'),
      businessName: get('businessName'),
      phone: normalizePhone(get('phone'))?.e164 ?? null,
      email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null,
      address: get('address'),
      district: get('district'),
      state: get('state'),
    });
  }
  return { agents, skipped, columns: cols };
}
