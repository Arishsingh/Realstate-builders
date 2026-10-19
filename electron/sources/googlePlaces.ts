/**
 * Google Places API (New) source.
 *
 * Runs several "real estate agent in {location}"-style Text Search queries (more for each
 * selected property type), paginating until enough new leads are collected or results run out.
 *
 * Two modes (Settings → Google Places):
 *   combined – Text Search asks for phone/website/rating directly. One request per 20 places.
 *   details  – Text Search asks only for ids + basic fields, then Place Details is called
 *              only for places that aren't already in the database.
 */
import type { PropertyType, SearchFilters } from '../../src/shared/types';
import { AppFailure } from '../errors';
import { getSecret, getSettings } from '../settings';
import type { LeadSource, RawLead, SourceContext } from './types';

const BASE = 'https://places.googleapis.com/v1';

const BASIC_FIELDS = ['id', 'displayName', 'formattedAddress', 'googleMapsUri', 'businessStatus', 'types'];
const CONTACT_FIELDS = ['nationalPhoneNumber', 'internationalPhoneNumber', 'websiteUri', 'rating', 'userRatingCount'];

const BASE_QUERIES = ['real estate agent in {loc}', 'property dealer in {loc}', 'real estate broker in {loc}', 'real estate consultant in {loc}'];
const TYPE_QUERIES: Record<PropertyType, string[]> = {
  Plots: ['plot broker in {loc}', 'land dealer in {loc}'],
  Houses: ['house sale agent in {loc}', 'independent house broker in {loc}'],
  Flats: ['flat broker in {loc}', 'apartment resale agent in {loc}'],
  Bungalows: ['bungalow dealer in {loc}', 'villa broker in {loc}'],
  Commercial: ['commercial property broker in {loc}', 'office space broker in {loc}'],
};

export function buildQueries(location: string, types: PropertyType[]): string[] {
  const loc = location.trim();
  // Interleave: type-specific queries first (they match what the user asked for), then generic ones.
  const specific = types.flatMap((t) => TYPE_QUERIES[t] ?? []);
  return [...new Set([...specific, ...BASE_QUERIES])].map((q) => q.replace('{loc}', loc));
}

interface Place {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  businessStatus?: string;
  types?: string[];
  location?: { latitude: number; longitude: number };
}

interface GoogleErrorBody {
  error?: { code?: number; message?: string; status?: string; details?: { reason?: string }[] };
}

function failureFrom(status: number, body: GoogleErrorBody): AppFailure {
  const e = body.error ?? {};
  const reason = e.details?.find((d) => d.reason)?.reason ?? '';
  const msg = e.message ?? `HTTP ${status}`;
  if (reason === 'API_KEY_INVALID' || /api key not valid/i.test(msg)) {
    return new AppFailure('INVALID_API_KEY', 'Your Google Places API key is not valid. Check it in Settings.');
  }
  if (status === 429 || e.status === 'RESOURCE_EXHAUSTED') {
    return new AppFailure('QUOTA_EXCEEDED', 'Google Places quota exceeded. Wait a few minutes or raise the quota in Google Cloud Console.');
  }
  if (status === 403 || e.status === 'PERMISSION_DENIED') {
    return new AppFailure(
      'API_NOT_ENABLED',
      `Google refused the request: ${msg} Make sure "Places API (New)" is enabled and billing is set up for the key's project.`,
    );
  }
  return new AppFailure('UNKNOWN', `Google Places error: ${msg}`);
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

async function call<T>(url: string, init: RequestInit & { fieldMask: string; apiKey: string }, signal: AbortSignal): Promise<T> {
  const timeout = getSettings().requestTimeoutMs;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(1000 * 2 ** attempt, signal);
    try {
      const res = await fetch(url, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': init.apiKey,
          'X-Goog-FieldMask': init.fieldMask,
        },
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeout * 2)]),
      });
      const body = (await res.json().catch(() => ({}))) as T & GoogleErrorBody;
      if (res.ok) return body;
      const failure = failureFrom(res.status, body);
      // Retry only server errors; quota/key problems won't fix themselves in a few seconds.
      if (res.status >= 500) {
        lastErr = failure;
        continue;
      }
      throw failure;
    } catch (err) {
      if (signal.aborted || err instanceof AppFailure) throw err;
      lastErr = err;
    }
  }
  throw lastErr;
}

function apiKey(): string {
  const key = getSecret('placesApiKey');
  if (!key) throw new AppFailure('NO_API_KEY', 'Add your Google Places API key in Settings first.');
  return key;
}

async function textSearch(
  body: Record<string, unknown>,
  fields: string[],
  signal: AbortSignal,
): Promise<{ places?: Place[]; nextPageToken?: string }> {
  return call(
    `${BASE}/places:searchText`,
    { method: 'POST', body: JSON.stringify(body), apiKey: apiKey(), fieldMask: [...fields.map((f) => `places.${f}`), 'nextPageToken'].join(',') },
    signal,
  );
}

async function placeDetails(id: string, signal: AbortSignal): Promise<Place> {
  return call(`${BASE}/places/${encodeURIComponent(id)}`, { method: 'GET', apiKey: apiKey(), fieldMask: [...BASIC_FIELDS, ...CONTACT_FIELDS].join(',') }, signal);
}

/** Centre of the searched area, used to bias results to the configured radius. */
async function resolveCenter(location: string, signal: AbortSignal) {
  const res = await textSearch({ textQuery: location, pageSize: 1, regionCode: 'IN', languageCode: 'en' }, ['id', 'location'], signal);
  return res.places?.[0]?.location ?? null;
}

function toRawLead(p: Place, types: PropertyType[]): RawLead {
  return {
    externalId: p.id,
    businessName: p.displayName?.text?.trim() || 'Unnamed business',
    phone: p.internationalPhoneNumber || p.nationalPhoneNumber || null,
    website: p.websiteUri || null,
    address: p.formattedAddress || null,
    rating: p.rating ?? null,
    ratingCount: p.userRatingCount ?? null,
    mapsUrl: p.googleMapsUri || null,
    propertyTypes: types,
  };
}

/**
 * Find one named business (e.g. a builder from a RERA listing) and return its Google contact
 * details. One Text Search Enterprise request. Returns null when nothing plausible matches.
 */
export async function lookupBusiness(name: string, area: string, signal: AbortSignal): Promise<RawLead | null> {
  const res = await textSearch({ textQuery: `${name} ${area}`, pageSize: 1, regionCode: 'IN', languageCode: 'en' }, [...BASIC_FIELDS, ...CONTACT_FIELDS], signal);
  const p = res.places?.[0];
  if (!p || p.businessStatus === 'CLOSED_PERMANENTLY') return null;
  // Require a shared distinctive word so "Shree Developers" doesn't match a random shop.
  const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !GENERIC_WORDS.has(w)));
  const wanted = words(name);
  const got = words(p.displayName?.text ?? '');
  if (wanted.size && ![...wanted].some((w) => got.has(w))) return null;
  return toRawLead(p, []);
}

const GENERIC_WORDS = new Set(['private', 'limited', 'developers', 'developer', 'builders', 'builder', 'infra', 'infrastructure', 'realty', 'estates', 'estate', 'homes', 'housing', 'projects', 'constructions', 'construction', 'group', 'company', 'associates', 'properties', 'buildcon', 'buildtech', 'india']);

export async function testPlacesKey(): Promise<string> {
  const ctrl = new AbortController();
  const res = await textSearch({ textQuery: 'real estate agent in Pune', pageSize: 1, regionCode: 'IN' }, ['id', 'displayName'], ctrl.signal);
  const name = res.places?.[0]?.displayName?.text;
  return name ? `Key works. Sample result: ${name}` : 'Key works (no sample result returned).';
}

export const googlePlacesSource: LeadSource = {
  id: 'google_places',
  name: 'Google Places',
  description: 'Businesses listed on Google Maps (Places API New). Needs your own API key.',

  unavailableReason() {
    return getSettings().hasPlacesApiKey ? null : 'Add a Google Places API key in Settings.';
  },

  async search(location: string, limit: number, filters: SearchFilters, ctx: SourceContext) {
    const settings = getSettings();
    const mode = settings.placesMode;
    const fields = mode === 'combined' ? [...BASIC_FIELDS, ...CONTACT_FIELDS] : BASIC_FIELDS;
    const radiusKm = filters.radiusKm ?? settings.defaultRadiusKm;
    const out: RawLead[] = [];
    const seen = new Set<string>();

    ctx.progress(`Locating "${location}"…`);
    const center = await resolveCenter(location, ctx.signal).catch((err) => {
      if (err instanceof AppFailure && err.code !== 'UNKNOWN') throw err;
      return null; // still search, just without a location bias
    });
    const locationBias = center ? { circle: { center, radius: Math.min(50_000, radiusKm * 1000) } } : undefined;

    const queries = buildQueries(location, filters.propertyTypes);
    for (const [qi, textQuery] of queries.entries()) {
      let pageToken: string | undefined;
      for (let page = 0; page < settings.maxPagesPerQuery; page++) {
        if (out.length >= limit) return out;
        ctx.progress(`Searching "${textQuery}" (query ${qi + 1}/${queries.length}, page ${page + 1})`);
        const body: Record<string, unknown> = { textQuery, pageSize: 20, regionCode: 'IN', languageCode: 'en' };
        if (locationBias) body.locationBias = locationBias;
        if (pageToken) body.pageToken = pageToken;
        const res = await textSearch(body, fields, ctx.signal);

        for (const p of res.places ?? []) {
          if (out.length >= limit) break;
          if (seen.has(p.id) || p.businessStatus === 'CLOSED_PERMANENTLY') continue;
          seen.add(p.id);
          let lead = toRawLead(p, filters.propertyTypes);
          if (ctx.isKnown(lead)) continue;
          if (mode === 'details') {
            ctx.progress(`Fetching details for ${lead.businessName}`);
            lead = toRawLead(await placeDetails(p.id, ctx.signal), filters.propertyTypes);
            if (ctx.isKnown(lead)) continue; // phone/website may now match a stored lead
          }
          out.push(lead);
          ctx.onLead?.(lead);
        }

        pageToken = res.nextPageToken;
        if (!pageToken) break;
        await sleep(300, ctx.signal); // tokens can take a moment to become valid
      }
    }
    return out;
  },
};
