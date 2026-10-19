/**
 * RERA registry source (optional). Agents are imported from a CSV export of a state RERA
 * registered-agent list (e.g. MahaRERA). The registry is used two ways:
 *   1. as a lead source: agents whose address/district matches the searched location;
 *   2. to tag leads from other sources as "RERA Registered" with their registration number.
 */
import fs from 'node:fs';
import * as db from '../db';
import type { LeadSource } from './types';
import { parseReraCsv } from './reraParse';

export { detectColumns, parseReraCsv } from './reraParse';

export function importReraFile(filePath: string) {
  const { agents, skipped, columns } = parseReraCsv(fs.readFileSync(filePath, 'utf8'));
  db.upsertReraAgents(agents);
  const tagged = db.tagLeadsWithRera();
  return { imported: agents.length, skipped, tagged, columns };
}

export const reraSource: LeadSource = {
  id: 'rera',
  name: 'RERA registry',
  description: 'Registered agents from a state RERA list you imported as CSV (Settings → RERA).',

  unavailableReason() {
    return db.reraStats().agents > 0 ? null : 'Import a RERA agent CSV first.';
  },

  async search(location, limit, filters, ctx) {
    ctx.progress('Checking the RERA registry…');
    const out = [];
    for (const a of db.searchReraAgents(location, limit * 3)) {
      if (out.length >= limit) break;
      const lead = {
        externalId: `rera:${a.regNumber}`,
        name: a.name,
        businessName: a.businessName || a.name || a.regNumber,
        phone: a.phone,
        email: a.email,
        address: [a.address, a.district, a.state].filter(Boolean).join(', ') || null,
        reraNumber: a.regNumber,
        propertyTypes: filters.propertyTypes,
      };
      if (ctx.isKnown(lead)) continue;
      out.push(lead);
      ctx.onLead?.(lead);
    }
    return out;
  },
};
