/**
 * Pure helpers for the Google Maps browser source: turning what the Maps page shows into a lead.
 * Same selectors as cosci-leads' Playwright scraper (scraper/sources/browser.py).
 */
import type { RawLead } from './types';

/** What the in-page script reads from an open place panel. */
export interface MapsPlaceRecord {
  title: string;
  phoneItemId: string; // data-item-id of the phone row, e.g. "phone:tel:09822012345"
  phoneLabel: string; // its aria-label, e.g. "Phone: 098220 12345"
  address: string;
  website: string;
  category: string;
  stars: string; // aria-label of the rating, e.g. "4.3 stars 128 Reviews"
  url: string;
}

/** The place ID ("0x…:0x…") is the stable part of a Maps place URL; the rest is per-query tracking. */
const PLACE_ID_RE = /!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i;
export function placeKey(href: string): string {
  return PLACE_ID_RE.exec(href)?.[1].toLowerCase() ?? href.split('?')[0];
}

/** Categories that turn up for agent searches but aren't brokers or developers. */
const NOT_AGENTS = /\b(bank|atm|hotel|restaurant|cafe|school|college|hospital|clinic|temple|church|mosque|gym|salon|shop|store|supermarket|pharmacy|petrol|police|post office|government office|lawyer|advocate|courier|insurance)\b/i;

export function toRawLead(rec: MapsPlaceRecord, propertyTypes: RawLead['propertyTypes']): RawLead | null {
  const title = rec.title.trim();
  if (!title || /^(results|google maps)$/i.test(title)) return null;
  if (rec.category && NOT_AGENTS.test(rec.category) && !/real estate|property|estate agent|builder|developer|broker|land/i.test(rec.category)) return null;

  const phone = rec.phoneItemId.replace(/^phone:tel:/i, '').trim() || rec.phoneLabel.replace(/^phone:\s*/i, '').trim() || null;
  const website = /^https?:\/\//i.test(rec.website) && !/google\.[a-z.]+\/(url|maps)/i.test(rec.website) ? rec.website : null;
  const rating = /([\d.]+)\s+stars?/i.exec(rec.stars);
  const reviews = /([\d,]+)\s+review/i.exec(rec.stars);
  return {
    externalId: `gmaps:${placeKey(rec.url)}`,
    businessName: title,
    phone,
    website,
    address: rec.address.replace(/^address:\s*/i, '').trim() || null,
    rating: rating ? Number(rating[1]) : null,
    ratingCount: reviews ? Number(reviews[1].replace(/,/g, '')) : null,
    mapsUrl: rec.url.split('?')[0],
    notes: rec.category || null,
    propertyTypes,
  };
}
