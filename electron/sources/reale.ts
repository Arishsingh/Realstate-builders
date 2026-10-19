/**
 * reale.in source: builders/promoters with RERA-registered projects in the searched area.
 *
 * Uses reale.in's free public JSON API (https://reale.in/data, CC BY 4.0, no key). It covers the
 * state registries reale.in reads (Rajasthan, Haryana, Kerala, Telangana, Bihar, Odisha, Jharkhand,
 * Himachal Pradesh at the time of writing). The API has no phone numbers or emails, so when a
 * Google Places key is set each builder is looked up on Google for its public business contacts.
 */
import { getSettings } from '../settings';
import { lookupBusiness } from './googlePlaces';
import { groupByPromoter, locationParts, promoterNotes, type RealeProject } from './realeData';
import type { LeadSource, RawLead } from './types';

const API = 'https://reale.in/api/v1';
const USER_AGENT = 'PropLeads/1.0 (desktop lead tool; data: reale.in)';
const MAX_PAGES = 5; // 40 projects per page

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(getSettings().requestTimeoutMs * 2)]),
  });
  if (!res.ok) throw new Error(`reale.in answered HTTP ${res.status}`);
  return (await res.json()) as T;
}

/**
 * Projects for each part of the location, most specific first ("Mansarovar", then "Jaipur").
 * When the location names a city, results from other cities are dropped ("Mansarovar" also
 * exists in Ranchi).
 */
async function findProjectTiers(location: string, wanted: number, signal: AbortSignal, progress: (m: string) => void): Promise<RealeProject[][]> {
  const parts = locationParts(location);
  const tiers: RealeProject[][] = [];
  let total = 0;
  for (const [i, part] of parts.entries()) {
    const broader = parts.slice(i + 1).map((p) => p.toLowerCase());
    const tier: RealeProject[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      progress(`Reading RERA projects for "${part}" from reale.in (page ${page})`);
      const res = await getJson<{ projects: RealeProject[]; pages: number }>(`${API}/projects?q=${encodeURIComponent(part)}&sort=newest&page=${page}`, signal);
      tier.push(...(res.projects ?? []).filter((p) => inArea(p, broader)));
      if (page >= (res.pages ?? 1)) break;
      await sleep(1000, signal); // the API asks for "a few requests a second" at most; stay well below
    }
    tiers.push(tier);
    total += tier.length;
    // A few projects per wanted lead is plenty; don't widen the area unless needed.
    if (total >= wanted * 3) break;
    if (i < parts.length - 1) await sleep(1000, signal);
  }
  return tiers;
}

function inArea(p: RealeProject, broader: string[]) {
  if (!broader.length) return true;
  const text = [p.district, p.locality, p.name].join(' ').toLowerCase();
  return broader.some((b) => text.includes(b));
}

export const realeSource: LeadSource = {
  id: 'reale',
  name: 'RERA builders (reale.in)',
  description: 'Builders/promoters with RERA-registered projects in the area, from reale.in (RJ, HR, KL, TS, BR, OD, JH, HP). Contacts looked up on Google if a key is set.',

  unavailableReason() {
    return null;
  },

  async search(location, limit, filters, ctx) {
    const settings = getSettings();
    const lookup = settings.lookupBuilderContacts && settings.hasPlacesApiKey;
    // Builders active in the locality first, then the rest of the city.
    const tiers = await findProjectTiers(location, limit, ctx.signal, ctx.progress);
    const seenKeys = new Set<string>();
    const promoters = tiers.flatMap((t) => groupByPromoter(t, filters.propertyTypes)).filter((g) => !seenKeys.has(g.key) && seenKeys.add(g.key));
    if (!promoters.length) {
      ctx.progress('No RERA builders found for this location on reale.in (it covers RJ, HR, KL, TS, BR, OD, JH, HP).');
      return [];
    }

    const out: RawLead[] = [];
    for (const g of promoters) {
      if (out.length >= limit) break;
      const area = g.localities[0] ? `${g.localities[0]}, ${g.district ?? ''}` : (g.district ?? location);
      let lead: RawLead = {
        externalId: `reale:${g.key}`,
        businessName: g.name,
        address: [...new Set([...g.localities.slice(0, 3), g.district].filter((x): x is string => Boolean(x)))].join(', ') || null,
        propertyTypes: g.propertyTypes.length ? g.propertyTypes : filters.propertyTypes,
        notes: promoterNotes(g),
        website: null,
      };
      if (ctx.isKnown(lead)) continue;
      if (lookup) {
        ctx.progress(`Looking up contact details for ${g.name}`);
        try {
          const found = await lookupBusiness(g.name, area, ctx.signal);
          if (found) {
            lead = { ...lead, phone: found.phone, website: found.website, rating: found.rating, ratingCount: found.ratingCount, mapsUrl: found.mapsUrl, address: found.address ?? lead.address };
          }
        } catch (err) {
          if (ctx.signal.aborted) throw err;
          // Places problems (quota, key) shouldn't lose the RERA lead itself.
        }
        if (ctx.isKnown(lead)) continue; // the same business may already be stored from Google
      }
      out.push(lead);
      ctx.onLead?.(lead);
    }
    return out;
  },
};
