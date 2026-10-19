/**
 * Import leads from a CSV file: contacts collected by hand from portals or directories,
 * a PropLeads export, or any spreadsheet with business/phone/email columns.
 * Pure parsing here (unit-tested); saving happens in importLeadsFile.
 */
import Papa from 'papaparse';
import type { PhoneType, PropertyType } from '../src/shared/types';
import { dedupeDomain, normalizePhone } from './normalize';

export interface ParsedLead {
  name: string | null;
  businessName: string;
  phoneRaw: string | null;
  phone: string | null;
  phoneType: PhoneType;
  email: string | null;
  website: string | null;
  domain: string | null;
  address: string | null;
  reraNumber: string | null;
  notes: string | null;
  propertyTypes: PropertyType[];
}

type Field = 'name' | 'businessName' | 'phone' | 'email' | 'website' | 'address' | 'city' | 'reraNumber' | 'notes';

const ALIASES: Record<Field, string[]> = {
  businessName: ['businessname', 'business', 'company', 'companyname', 'firm', 'firmname', 'agency', 'agencyname', 'organisation', 'organization', 'title', 'listingname'],
  name: ['name', 'contactname', 'contactperson', 'person', 'agentname', 'ownername', 'fullname'],
  phone: ['phone', 'phonenumber', 'mobile', 'mobileno', 'mobilenumber', 'contact', 'contactno', 'contactnumber', 'telephone', 'tel', 'whatsapp'],
  email: ['email', 'emailid', 'emailaddress', 'mail'],
  website: ['website', 'web', 'url', 'site', 'websiteurl', 'homepage'],
  address: ['address', 'fulladdress', 'officeaddress', 'location', 'area', 'locality'],
  city: ['city', 'district', 'town'],
  reraNumber: ['reranumber', 'rerano', 'registrationnumber', 'registrationno', 'rera', 'reraregistration'],
  notes: ['notes', 'note', 'comments', 'remarks', 'description', 'source'],
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function detectLeadColumns(headers: string[]): Record<Field, string | null> {
  const used = new Set<string>();
  const out = {} as Record<Field, string | null>;
  // Business name first so a generic "Name" column isn't taken for it when a "Company" column exists.
  for (const field of ['businessName', 'name', 'phone', 'email', 'website', 'reraNumber', 'city', 'address', 'notes'] as Field[]) {
    const h = headers.find((x) => !used.has(x) && ALIASES[field].includes(norm(x)));
    out[field] = h ?? null;
    if (h) used.add(h);
  }
  return out;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

export function parseLeadCsv(text: string): { leads: ParsedLead[]; skipped: number; columns: Record<Field, string | null> } {
  const parsed = Papa.parse<Record<string, string>>(text.replace(/^﻿/, ''), { header: true, skipEmptyLines: true });
  const headers = parsed.meta.fields ?? [];
  const cols = detectLeadColumns(headers);
  if (!cols.businessName && !cols.name) throw new Error(`Couldn't find a name/business column. Columns found: ${headers.join(', ') || '(none)'}`);
  if (!cols.phone && !cols.email && !cols.website) throw new Error('The file needs at least one of: phone, email or website columns.');

  const leads: ParsedLead[] = [];
  let skipped = 0;
  for (const row of parsed.data) {
    const get = (f: Field) => {
      const c = cols[f];
      const v = c ? String(row[c] ?? '').trim() : '';
      return v || null;
    };
    const businessName = get('businessName') ?? get('name');
    const phoneRaw = get('phone')?.split(/[,/;]| or /i)[0].trim() || null; // first number when several are listed
    const phone = normalizePhone(phoneRaw);
    const emailRaw = get('email')?.split(/[,;\s]+/)[0].toLowerCase() ?? null;
    const email = emailRaw && EMAIL_RE.test(emailRaw) ? emailRaw : null;
    const website = get('website');
    if (!businessName || (!phone && !email && !website)) {
      skipped++;
      continue;
    }
    const address = [get('address'), get('city')].filter(Boolean).join(', ') || null;
    leads.push({
      name: cols.businessName ? get('name') : null,
      businessName,
      phoneRaw,
      phone: phone?.e164 ?? null,
      phoneType: phone?.type ?? 'unknown',
      email,
      website,
      domain: dedupeDomain(website),
      address,
      reraNumber: get('reraNumber'),
      notes: get('notes'),
      propertyTypes: [],
    });
  }
  return { leads, skipped, columns: cols };
}
