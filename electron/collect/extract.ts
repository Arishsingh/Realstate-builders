/**
 * Turns what the user copies or views in the Collector into leads:
 *  - parseContacts: free text (a selection or a pasted list from Justdial, 99acres, Maps…) → contact candidates;
 *  - reraTablesToAgents: the tables on a RERA results page the user is looking at → registry agents.
 * Pure functions, unit-tested. Nothing here fetches pages: the user browses, the app only reads what they chose.
 */
import Papa from 'papaparse';
import type { ContactCandidate } from '../../src/shared/types';
import { normalizePhone } from '../normalize';
import { parseReraCsv } from '../sources/reraParse';

const PHONE_RE = /(?:\+?91[\s-]*)?(?:0[\s-]*)?(?:[6-9]\d{2}[\s-]?\d{3}[\s-]?\d{4}|[6-9]\d{4}[\s-]?\d{5}|\d{2,4}[\s-]?\d{3,4}[\s-]?\d{3,4}|\d{2,4}[\s-]?\d{6,8})/g;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const HAS_EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
const URL_RE = /\b(?:https?:\/\/[^\s<>"']+|www\.[^\s<>"']+|[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|in|co\.in|net|org|realty|homes|properties|estate)(?:\/[^\s<>"']*)?)/gi;
/** MahaRERA agents look like A51800012345; other states use slashes, e.g. RAJ/A/2019/123 or HRERA-PKL-AGT-123. */
const RERA_RE = /\b(?:[AP]\d{11}|[A-Z]{2,6}[/-](?:[A-Z]{1,4}[/-])?(?:\d{2,4}[/-])?(?:AGT[/-])?\d{2,6})\b/;
const RERA_LABEL_RE = /\bRERA\b[^A-Za-z0-9]{0,12}(?:(?:No|Number|Reg(?:istration)?)\.?[^A-Za-z0-9]{0,6})?([A-Z0-9][A-Z0-9/-]{5,})/i;

/** Lines that are listing furniture rather than a business name. */
const NOISE_RE =
  /(★|☆|\bratings?\b|\breviews?\b|\bverified\b|\btrust\b|\bopen now\b|\bclosed\b|\bcall now\b|\bsend enquiry\b|\bget best price\b|\bwhatsapp\b|\bshow number\b|\bdirections?\b|\bwebsite\b|\bsponsored\b|\bad\b|\byears? in business\b|^\d+(\.\d+)?$|^[\W\d]+$)/i;
const ADDRESS_HINT_RE = /\b(road|rd|nagar|colony|society|near|opp|opposite|lane|chowk|sector|phase|plot no|shop|office|floor|complex|tower|plaza|market|east|west|pin|\d{6})\b/i;
const PERSON_RE = /^(?:contact(?:\s*person)?|agent|owner|name)\s*[:-]\s*(.+)$|^((?:mr|mrs|ms|shri|smt|dr)\.?\s+[a-z .]{2,40})$/i;

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function phonesIn(line: string) {
  const out: { raw: string; e164: string; type: ContactCandidate['phoneType'] }[] = [];
  for (const m of line.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length < 10) continue;
    const p = normalizePhone(m[0]);
    if (p) out.push({ raw: clean(m[0]), e164: p.e164, type: p.type });
  }
  return out;
}

const hasContact = (line: string) => phonesIn(line).length > 0 || HAS_EMAIL_RE.test(line);

function websiteIn(line: string, emails: string[]) {
  for (const m of line.matchAll(URL_RE)) {
    const u = m[0].replace(/[).,;]+$/, '');
    // Skip email domains, the portals themselves and map links: they're not the agent's site.
    if (emails.some((e) => e.endsWith(u.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]))) continue;
    if (/(justdial|99acres|magicbricks|housing\.com|google\.|goo\.gl|facebook|instagram|linkedin|nobroker|squareyards|commonfloor|maharera|rera)/i.test(u)) continue;
    return /^https?:/i.test(u) ? u : `https://${u}`;
  }
  return null;
}

/** Splits text into one chunk per business: blank lines first, then after each phone/email line. */
function segments(text: string): string[][] {
  const blocks = text
    .replace(/\r/g, '')
    .split(/\n\s*\n/)
    .map((b) => b.split('\n').map(clean).filter(Boolean))
    .filter((b) => b.length);
  const out: string[][] = [];
  for (const block of blocks) {
    let cur: string[] = [];
    let curHasContact = false;
    for (const line of block) {
      const contact = hasContact(line);
      // A non-contact line after a contact line starts the next business.
      if (curHasContact && !contact) {
        out.push(cur);
        cur = [];
        curHasContact = false;
      }
      cur.push(line);
      if (contact) curHasContact = true;
    }
    if (cur.length) {
      // Trailing lines with no contact (an address after the phone) belong to the previous business.
      if (!curHasContact && out.length && out[out.length - 1] !== cur && block.length > cur.length) out[out.length - 1].push(...cur);
      else out.push(cur);
    }
  }
  return out;
}

function candidateFrom(lines: string[]): ContactCandidate | null {
  const text = lines.join('\n');
  const emails = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
  const phones = lines.flatMap(phonesIn);
  const website = lines.map((l) => websiteIn(l, emails)).find(Boolean) ?? null;
  if (!phones.length && !emails.length && !website) return null;

  let name: string | null = null;
  const rest: string[] = [];
  for (const l of lines) {
    const m = l.match(PERSON_RE);
    if (m) name = clean(m[1] ?? m[2]);
    else rest.push(l);
  }

  const isText = (l: string) => !phonesIn(l).length && !(l.match(EMAIL_RE) ?? []).length && !websiteIn(l, emails) && !NOISE_RE.test(l) && l.length >= 2 && l.length <= 90;
  const textLines = rest.filter(isText).map((l) => l.replace(/^\d+[.)]\s*/, ''));
  const businessName = textLines.find((l) => !ADDRESS_HINT_RE.test(l) || l.split(' ').length <= 4) ?? textLines[0] ?? null;
  const address = textLines.find((l) => l !== businessName && (ADDRESS_HINT_RE.test(l) || l.includes(','))) ?? null;
  const rera = text.match(RERA_LABEL_RE)?.[1] ?? text.match(RERA_RE)?.[0] ?? null;

  const mobile = phones.find((p) => p.type === 'mobile') ?? phones[0];
  return {
    businessName: businessName ?? (emails[0] ? emails[0].split('@')[1].split('.')[0] : website ? website.replace(/^https?:\/\/(www\.)?/, '').split(/[./]/)[0] : 'Unknown'),
    name,
    phone: mobile?.e164 ?? null,
    phoneRaw: mobile?.raw ?? null,
    phoneType: mobile?.type ?? 'unknown',
    email: emails[0] ?? null,
    website,
    address,
    reraNumber: rera,
  };
}

/** Contacts found in copied text. Several businesses in one paste come back as several candidates. */
export function parseContacts(text: string): ContactCandidate[] {
  const out: ContactCandidate[] = [];
  const seen = new Set<string>();
  for (const seg of segments(String(text ?? '').slice(0, 200_000))) {
    const c = candidateFrom(seg);
    if (!c) continue;
    const key = c.phone ?? c.email ?? c.website ?? c.businessName;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

const REG_VALUE_RE = /^[A-Z]{1,6}[A-Z0-9/-]*\d{3,}[A-Z0-9/-]*$/i;

/**
 * Agents from the tables on a RERA results page. Uses the header row when it names a
 * registration-number column; otherwise looks for a column whose values look like registration numbers.
 */
export function reraTablesToAgents(tables: string[][][]) {
  let best: ReturnType<typeof parseReraCsv> | null = null;
  for (const raw of tables) {
    const rows = raw.map((r) => r.map(clean)).filter((r) => r.some(Boolean));
    if (rows.length < 2) continue;
    let result: ReturnType<typeof parseReraCsv> | null = null;
    for (let h = 0; h < Math.min(3, rows.length - 1) && !result; h++) {
      try {
        const r = parseReraCsv(Papa.unparse([rows[h], ...rows.slice(h + 1)]));
        if (r.agents.length) result = r;
      } catch {
        /* no registration-number header in this row */
      }
    }
    if (!result) {
      const width = Math.max(...rows.map((r) => r.length));
      const regCol = Array.from({ length: width }, (_, c) => c).find((c) => {
        const vals = rows.map((r) => r[c] ?? '').filter(Boolean);
        return vals.length >= 1 && vals.filter((v) => REG_VALUE_RE.test(v)).length / vals.length >= 0.6;
      });
      if (regCol !== undefined) {
        const nameCol = Array.from({ length: width }, (_, c) => c).find((c) => c !== regCol && rows.some((r) => /[a-z]{3}/i.test(r[c] ?? '') && !REG_VALUE_RE.test(r[c] ?? '')));
        const header = Array.from({ length: width }, (_, c) => (c === regCol ? 'Registration Number' : c === nameCol ? 'Name' : `Column ${c + 1}`));
        try {
          result = parseReraCsv(Papa.unparse([header, ...rows.filter((r) => REG_VALUE_RE.test(r[regCol] ?? ''))]));
        } catch {
          result = null;
        }
      }
    }
    if (result && (!best || result.agents.length > best.agents.length)) best = result;
  }
  return best;
}
