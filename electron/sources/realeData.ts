/**
 * Pure helpers for the reale.in source (no Electron imports, unit-tested).
 * reale.in republishes state RERA project registries as JSON (CC BY 4.0, "data: reale.in").
 */
import type { PropertyType } from '../../src/shared/types';

export interface RealeProject {
  state_code: string;
  reg_no: string;
  name: string;
  url?: string;
  promoter_name: string | null;
  project_type: string | null;
  status: string | null;
  district: string | null;
  locality: string | null;
  registration_date?: string | null;
}

export interface Promoter {
  key: string;
  name: string;
  stateCode: string;
  district: string | null;
  localities: string[];
  projects: RealeProject[];
  propertyTypes: PropertyType[];
}

/**
 * reale.in's terms forbid using its data to contact individuals, so only promoters that are
 * clearly organisations (LLP, Pvt Ltd, "Developers", "Builders"…) become leads.
 */
const COMPANY_RE =
  /\b(llp|pvt|private|ltd|limited|inc|corporation|corp|company|co\.|developers?|builders?|buildcon|buildtech|buildwell|constructions?|infra\w*|realty|realtors|real estate|estates?|homes|housing|properties|projects|promoters|associates|enterprises|group|ventures|township|habitat|land(s)?|society|trust|authority|board|nigam|parishad)\b|&/i;

export function isOrganisation(name: string | null | undefined): name is string {
  return Boolean(name && name.trim().length > 2 && COMPANY_RE.test(name));
}

export function projectTypes(type: string | null): PropertyType[] {
  switch ((type ?? '').toLowerCase()) {
    case 'plotted':
      return ['Plots'];
    case 'residential':
      return ['Flats', 'Houses', 'Bungalows'];
    case 'commercial':
      return ['Commercial'];
    case 'mixed':
      return ['Flats', 'Commercial'];
    default:
      return [];
  }
}

/** "Malviya Nagar, Jaipur" → ["Malviya Nagar", "Jaipur"]: most specific first. */
export function locationParts(location: string): string[] {
  return [...new Set(location.split(',').map((s) => s.trim()).filter((s) => s.length > 2))];
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/** One lead per promoter: group projects and keep only those matching the wanted property types. */
export function groupByPromoter(projects: RealeProject[], wanted: PropertyType[]): Promoter[] {
  const map = new Map<string, Promoter>();
  for (const p of projects) {
    if (!isOrganisation(p.promoter_name)) continue;
    if (p.status && ['revoked', 'withdrawn'].includes(p.status)) continue;
    const types = projectTypes(p.project_type);
    if (wanted.length && types.length && !types.some((t) => wanted.includes(t))) continue;
    const key = `${p.state_code}:${slug(p.promoter_name)}`;
    let g = map.get(key);
    if (!g) {
      g = { key, name: p.promoter_name.trim(), stateCode: p.state_code, district: p.district, localities: [], projects: [], propertyTypes: [] };
      map.set(key, g);
    }
    g.projects.push(p);
    if (p.locality && !g.localities.includes(p.locality)) g.localities.push(p.locality);
    for (const t of types) if (!g.propertyTypes.includes(t)) g.propertyTypes.push(t);
  }
  // Most active promoters first.
  return [...map.values()].sort((a, b) => b.projects.length - a.projects.length);
}

export function promoterNotes(g: Promoter): string {
  const names = g.projects.slice(0, 5).map((p) => `${p.name} (${p.reg_no})`);
  const more = g.projects.length > 5 ? `, +${g.projects.length - 5} more` : '';
  return `Builder/promoter with ${g.projects.length} RERA project${g.projects.length === 1 ? '' : 's'}: ${names.join('; ')}${more}. Data: reale.in`;
}
