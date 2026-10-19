/**
 * Pure helpers for cleaning lead data: phone numbers, website domains and de-duplication.
 * No Electron imports, so these are unit-tested directly.
 */
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import type { PhoneType } from '../src/shared/types';

export interface NormalizedPhone {
  e164: string;
  type: PhoneType;
}

/** Parse an Indian (or international) number to E.164 and classify it as mobile or landline. */
export function normalizePhone(raw: string | null | undefined, defaultCountry: 'IN' = 'IN'): NormalizedPhone | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d+]/g, '');
  if (cleaned.replace(/\D/g, '').length < 6) return null;
  const p = parsePhoneNumberFromString(raw, defaultCountry);
  if (!p || !p.isValid()) return null;
  const t = p.getType();
  const type: PhoneType = t === 'MOBILE' ? 'mobile' : t === 'FIXED_LINE' ? 'landline' : t === 'FIXED_LINE_OR_MOBILE' ? 'mobile' : 'unknown';
  return { e164: p.number, type };
}

/**
 * Hosts shared by many unrelated businesses (social profiles, listing portals, site builders).
 * Two leads with a website on one of these are not duplicates of each other.
 */
const SHARED_HOSTS = [
  'facebook.com',
  'instagram.com',
  'linkedin.com',
  'twitter.com',
  'x.com',
  'youtube.com',
  'wa.me',
  'whatsapp.com',
  'google.com',
  'business.site',
  'sites.google.com',
  'blogspot.com',
  'wordpress.com',
  'wixsite.com',
  'justdial.com',
  'sulekha.com',
  'indiamart.com',
  'magicbricks.com',
  '99acres.com',
  'housing.com',
  'nobroker.in',
  'squareyards.com',
  'linktr.ee',
  'magicpin.in',
  'olx.in',
  'quikr.com',
  'commonfloor.com',
  'makaan.com',
  'proptiger.com',
  'housing.com',
];

export function websiteDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export function isSharedHost(domain: string | null | undefined): boolean {
  if (!domain) return false;
  return SHARED_HOSTS.some((h) => domain === h || domain.endsWith('.' + h));
}

/** Domain to use as a de-duplication key, or null when the site is on a shared host. */
export function dedupeDomain(url: string | null | undefined): string | null {
  const d = websiteDomain(url);
  return d && !isSharedHost(d) ? d : null;
}

export interface DedupeKeys {
  phone?: string | null;
  email?: string | null;
  domain?: string | null;
}

/**
 * Tracks keys seen so far: phone first, then email, then website domain.
 * `add` returns false when the candidate matches something already seen.
 */
export class Deduper {
  private phones = new Set<string>();
  private emails = new Set<string>();
  private domains = new Set<string>();

  has(k: DedupeKeys): boolean {
    return Boolean(
      (k.phone && this.phones.has(k.phone)) || (k.email && this.emails.has(k.email.toLowerCase())) || (k.domain && this.domains.has(k.domain)),
    );
  }

  add(k: DedupeKeys): boolean {
    if (this.has(k)) return false;
    if (k.phone) this.phones.add(k.phone);
    if (k.email) this.emails.add(k.email.toLowerCase());
    if (k.domain) this.domains.add(k.domain);
    return true;
  }
}

/** wa.me click-to-chat link. WhatsApp wants the number as digits only, without "+". */
export function whatsappUrl(e164: string | null | undefined, message?: string): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, '');
  if (digits.length < 8) return null;
  return `https://wa.me/${digits}${message ? `?text=${encodeURIComponent(message)}` : ''}`;
}
