import type { SourceInfo } from '../../src/shared/types';
import { googlePlacesSource } from './googlePlaces';
import { mapsBrowserSource } from './mapsBrowser';
import { realeSource } from './reale';
import { reraSource } from './rera';
import type { LeadSource } from './types';

/**
 * All lead sources, in the order they run. Add new plugins here.
 * Earlier sources get a fair share of the requested count; the last one fills whatever is left,
 * so the Google sources run last. The free Maps browser source is the fallback when there's no API key.
 */
export const SOURCES: LeadSource[] = [reraSource, realeSource, googlePlacesSource, mapsBrowserSource];

export function getSource(id: string) {
  return SOURCES.find((s) => s.id === id);
}

export function sourceInfo(): SourceInfo[] {
  return SOURCES.map((s) => {
    const reason = s.unavailableReason();
    return { id: s.id, name: s.name, description: s.description, available: !reason, unavailableReason: reason ?? undefined };
  });
}
