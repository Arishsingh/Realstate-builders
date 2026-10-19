/**
 * Search orchestration: runs the lead sources, normalizes and de-duplicates results,
 * saves them, then enriches leads that have a website with published email addresses.
 */
import type { Lead, SearchProgress, SearchRequest, SearchResult } from '../src/shared/types';
import * as db from './db';
import { PoliteFetcher } from './enrich/politeFetch';
import { findWebsiteEmails } from './enrich/websiteEmails';
import { AppFailure, toAppError } from './errors';
import { dedupeDomain, Deduper, normalizePhone } from './normalize';
import { getSettings } from './settings';
import { SOURCES } from './sources';
import type { RawLead } from './sources/types';

const ENRICH_CONCURRENCY = 4;

const running = new Map<number, AbortController>();

export function cancelSearch(searchId?: number) {
  for (const [id, ctrl] of running) if (searchId === undefined || id === searchId) ctrl.abort(new Error('cancelled'));
}

function keysOf(l: RawLead) {
  return { phone: normalizePhone(l.phone)?.e164 ?? null, email: l.email?.toLowerCase() ?? null, domain: dedupeDomain(l.website) };
}

export async function runSearch(req: SearchRequest, emit: (p: SearchProgress) => void): Promise<SearchResult> {
  const location = req.location.trim();
  const requested = Math.floor(Number(req.limit));
  if (!location) throw new AppFailure('VALIDATION', 'Enter a location, e.g. "Baner, Pune".');
  if (!Number.isFinite(requested) || requested < 1 || requested > 1000) throw new AppFailure('VALIDATION', 'Number of leads must be between 1 and 1000.');

  const settings = getSettings();
  const filters = req.filters ?? { propertyTypes: [] };
  const wanted = filters.sources?.length ? SOURCES.filter((s) => filters.sources!.includes(s.id)) : SOURCES;
  const usable = wanted.filter((s) => !s.unavailableReason());
  if (!usable.length) {
    const google = wanted.find((s) => s.id === 'google_places');
    if (google?.unavailableReason()) throw new AppFailure('NO_API_KEY', 'Add your Google Places API key in Settings first.');
    throw new AppFailure('VALIDATION', 'None of the selected sources are available. Check Settings.');
  }

  const searchId = db.createSearch(location, requested, filters.propertyTypes);
  const ctrl = new AbortController();
  running.set(searchId, ctrl);
  const signal = ctrl.signal;
  const warnings: string[] = [];
  let found = 0;
  let phase: SearchProgress['phase'] = 'starting';
  const progress = (message: string, percent: number) => emit({ searchId, phase, message, found, requested, percent: Math.round(Math.min(100, percent)) });

  // Everything already stored, plus everything collected in this search, counts as "known".
  const knownIds = db.knownPlaceIds();
  const seen = new Deduper();
  const isKnown = (l: RawLead) => {
    if (l.externalId && knownIds.has(l.externalId)) return true;
    const k = keysOf(l);
    return seen.has(k) || Boolean(db.findDuplicate({ phone: k.phone, email: k.email, domain: k.domain }));
  };

  const saved: Lead[] = [];
  try {
    // 1. Collect from each source until the requested number is reached.
    phase = 'searching';
    progress('Starting search…', 1);
    for (const [i, source] of usable.entries()) {
      const remaining = requested - saved.length;
      if (remaining <= 0) break;
      const isLast = i === usable.length - 1;
      const quota = isLast ? remaining : Math.min(remaining, Math.ceil(requested / usable.length));
      try {
        await source.search(location, quota, filters, {
          signal,
          progress: (m) => progress(m, 5 + (found / requested) * 55),
          isKnown,
          onLead: (raw) => {
            const k = keysOf(raw);
            if (!seen.add(k)) return;
            if (raw.externalId) knownIds.add(raw.externalId);
            const phone = normalizePhone(raw.phone);
            const lead = db.insertLead({
              placeId: raw.externalId ?? null,
              name: raw.name ?? null,
              businessName: raw.businessName,
              phoneRaw: raw.phone ?? null,
              phone: phone?.e164 ?? null,
              phoneType: phone?.type ?? 'unknown',
              email: raw.email?.toLowerCase() ?? null,
              website: raw.website ?? null,
              domain: k.domain,
              address: raw.address ?? null,
              rating: raw.rating ?? null,
              ratingCount: raw.ratingCount ?? null,
              mapsUrl: raw.mapsUrl ?? null,
              source: source.id,
              sources: [source.id],
              locationQuery: location,
              propertyTypes: raw.propertyTypes ?? filters.propertyTypes,
              reraNumber: raw.reraNumber ?? db.findReraAgent({ phone: phone?.e164, email: raw.email, name: raw.businessName })?.regNumber ?? null,
              notes: raw.notes ?? null,
              searchId,
            });
            saved.push(lead);
            found = saved.length;
            progress(`Found ${found} of ${requested}: ${lead.businessName}`, 5 + (found / requested) * 55);
          },
        });
      } catch (err) {
        if (signal.aborted) throw err;
        // A failing source shouldn't throw away results from the others, unless nothing came back at all.
        const e = toAppError(err);
        if (!saved.length && isLast) throw err;
        warnings.push(`${source.name}: ${e.message}`);
      }
    }

    // 2. Enrich leads that have a website with published email addresses.
    const enrich = filters.enrichEmails ?? settings.enrichEmailsByDefault;
    const toEnrich = enrich ? saved.filter((l) => l.website && !l.email) : [];
    if (toEnrich.length) {
      phase = 'enriching';
      const fetcher = new PoliteFetcher({ minDelayMs: settings.perDomainDelayMs, timeoutMs: settings.requestTimeoutMs });
      let done = 0;
      let next = 0;
      const worker = async () => {
        while (next < toEnrich.length) {
          if (signal.aborted) return;
          const lead = toEnrich[next++];
          progress(`Checking ${lead.domain ?? lead.website} for emails (${done + 1}/${toEnrich.length})`, 60 + (done / toEnrich.length) * 38);
          try {
            const emails = await findWebsiteEmails(lead.website!, fetcher, signal);
            if (emails.length) {
              const dup = db.findDuplicate({ email: emails[0] }, lead.id);
              if (dup) {
                // Same business already stored under another listing: keep the older one.
                db.deleteLeads([lead.id]);
                saved.splice(saved.indexOf(lead), 1);
                found = saved.length;
              } else {
                const updated = db.updateLead(lead.id, { email: emails[0], allEmails: emails });
                if (updated) saved[saved.indexOf(lead)] = updated;
              }
            }
          } catch {
            if (signal.aborted) return;
          }
          done++;
        }
      };
      await Promise.all(Array.from({ length: ENRICH_CONCURRENCY }, worker));
      if (signal.aborted) throw signal.reason;
    }

    phase = 'done';
    db.finishSearch(searchId, saved.length, 'done');
    progress(saved.length < requested ? `Found ${saved.length} of ${requested} requested` : `Found ${saved.length} leads`, 100);
    return { searchId, requested, found: saved.length, cancelled: false, leads: saved.map((l) => db.getLead(l.id) ?? l), warnings };
  } catch (err) {
    if (signal.aborted) {
      phase = 'cancelled';
      db.finishSearch(searchId, saved.length, 'cancelled');
      progress(`Cancelled. Kept ${saved.length} lead${saved.length === 1 ? '' : 's'} found so far.`, 100);
      return { searchId, requested, found: saved.length, cancelled: true, leads: saved.map((l) => db.getLead(l.id) ?? l), warnings };
    }
    phase = 'error';
    db.finishSearch(searchId, saved.length, 'error');
    const error = toAppError(err);
    progress(error.message, 100);
    if (saved.length) {
      // Partial results are still useful; report the error alongside them.
      return { searchId, requested, found: saved.length, cancelled: false, leads: saved, warnings: [...warnings, error.message], error };
    }
    throw err;
  } finally {
    running.delete(searchId);
  }
}
