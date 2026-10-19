/**
 * Lead source plugin interface. A source turns (location, limit, filters) into raw leads.
 * Register new sources in ./index.ts.
 */
import type { PropertyType, SearchFilters } from '../../src/shared/types';

export interface RawLead {
  /** Stable id within the source (e.g. Google place id), used to skip leads already stored. */
  externalId?: string | null;
  name?: string | null;
  businessName: string;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  rating?: number | null;
  ratingCount?: number | null;
  mapsUrl?: string | null;
  reraNumber?: string | null;
  notes?: string | null;
  propertyTypes?: PropertyType[];
}

export interface SourceContext {
  signal: AbortSignal;
  /** Human-readable status line for the progress bar. */
  progress(message: string): void;
  /** True when this candidate is already stored (or already collected in this search): skip it. */
  isKnown(lead: RawLead): boolean;
  /** Called for every new lead as soon as it's found, so the progress bar can move. */
  onLead?(lead: RawLead): void;
}

export interface LeadSource {
  id: string;
  name: string;
  description: string;
  /** Returns a reason when the source can't run right now (e.g. missing API key). */
  unavailableReason(): string | null;
  search(location: string, limit: number, filters: SearchFilters, ctx: SourceContext): Promise<RawLead[]>;
}
