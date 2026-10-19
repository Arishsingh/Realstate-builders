/**
 * SQLite storage (better-sqlite3). One file in the user-data folder.
 * All queries live here so the rest of the main process works with plain objects.
 */
import Database from 'better-sqlite3';
import type {
  Campaign,
  CampaignDetail,
  CampaignLead,
  CampaignLeadStatus,
  CampaignStatus,
  EmailStatus,
  EmailTemplate,
  Lead,
  LeadQuery,
  LeadStatus,
  PhoneType,
  PropertyType,
  ReraStats,
  SearchSummary,
} from '../src/shared/types';

let db: Database.Database;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  location TEXT NOT NULL,
  requested INTEGER NOT NULL,
  found INTEGER NOT NULL DEFAULT 0,
  property_types TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'running',
  started_at TEXT NOT NULL,
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  place_id TEXT UNIQUE,
  name TEXT,
  business_name TEXT NOT NULL,
  phone_raw TEXT,
  phone_e164 TEXT,
  phone_type TEXT NOT NULL DEFAULT 'unknown',
  email TEXT,
  all_emails TEXT NOT NULL DEFAULT '[]',
  website TEXT,
  domain TEXT,
  address TEXT,
  rating REAL,
  rating_count INTEGER,
  maps_url TEXT,
  source TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '[]',
  location_query TEXT,
  property_types TEXT NOT NULL DEFAULT '[]',
  rera_number TEXT,
  status TEXT NOT NULL DEFAULT 'New',
  notes TEXT,
  search_id INTEGER REFERENCES searches(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_contacted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON leads(phone_e164);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_domain ON leads(domain);
CREATE INDEX IF NOT EXISTS idx_leads_search ON leads(search_id);

-- Emails that must never be contacted again (survives deleting the lead).
CREATE TABLE IF NOT EXISTS suppressions (
  email TEXT PRIMARY KEY,
  reason TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rera_agents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reg_number TEXT NOT NULL UNIQUE,
  name TEXT,
  business_name TEXT,
  phone_e164 TEXT,
  email TEXT,
  address TEXT,
  district TEXT,
  state TEXT,
  imported_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rera_phone ON rera_agents(phone_e164);
CREATE INDEX IF NOT EXISTS idx_rera_email ON rera_agents(email);

CREATE TABLE IF NOT EXISTS templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  status_note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS campaign_leads (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  sent_at TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (campaign_id, lead_id)
);

CREATE TABLE IF NOT EXISTS email_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER,
  campaign_id INTEGER,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  message_id TEXT,
  sent_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_log_sent ON email_log(sent_at);
`;

const DEFAULT_TEMPLATE = {
  name: 'Introduction',
  subject: 'Quick question about your listings in {{location}}',
  body: `Hi {{name}},

I came across {{business}} while looking at property agents in {{location}}.

[Write one or two lines about why you are reaching out and what you offer.]

Would you be open to a short call this week?

Best regards,
[Your Name]`,
};

export function openDb(file: string) {
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  // Columns added after the first release.
  const leadCols = new Set((db.prepare('PRAGMA table_info(leads)').all() as { name: string }[]).map((c) => c.name));
  if (!leadCols.has('email_status')) db.exec('ALTER TABLE leads ADD COLUMN email_status TEXT');
  if (!leadCols.has('email_checked_at')) db.exec('ALTER TABLE leads ADD COLUMN email_checked_at TEXT');
  const count = db.prepare('SELECT COUNT(*) AS n FROM templates').get() as { n: number };
  if (count.n === 0) saveTemplate(DEFAULT_TEMPLATE);
  // A crash or quit while searching/sending leaves rows marked as running.
  db.prepare(`UPDATE searches SET status = 'interrupted' WHERE status = 'running'`).run();
  return db;
}

const now = () => new Date().toISOString();
const json = <T>(s: string | null | undefined, fallback: T): T => {
  try {
    return s ? (JSON.parse(s) as T) : fallback;
  } catch {
    return fallback;
  }
};

// ---------------------------------------------------------------------------
// Leads

interface LeadRow {
  id: number;
  place_id: string | null;
  name: string | null;
  business_name: string;
  phone_raw: string | null;
  phone_e164: string | null;
  phone_type: string;
  email: string | null;
  all_emails: string;
  website: string | null;
  domain: string | null;
  address: string | null;
  rating: number | null;
  rating_count: number | null;
  maps_url: string | null;
  source: string;
  sources: string;
  location_query: string | null;
  property_types: string;
  rera_number: string | null;
  status: string;
  notes: string | null;
  search_id: number | null;
  created_at: string;
  updated_at: string;
  last_contacted_at: string | null;
  email_status: string | null;
  email_checked_at: string | null;
}

function toLead(r: LeadRow): Lead {
  return {
    id: r.id,
    placeId: r.place_id,
    name: r.name,
    businessName: r.business_name,
    phone: r.phone_e164,
    phoneRaw: r.phone_raw,
    phoneType: r.phone_type as PhoneType,
    email: r.email,
    allEmails: json<string[]>(r.all_emails, []),
    website: r.website,
    domain: r.domain,
    address: r.address,
    rating: r.rating,
    ratingCount: r.rating_count,
    mapsUrl: r.maps_url,
    source: r.source,
    sources: json<string[]>(r.sources, [r.source]),
    locationQuery: r.location_query,
    propertyTypes: json<PropertyType[]>(r.property_types, []),
    reraNumber: r.rera_number,
    status: r.status as LeadStatus,
    notes: r.notes,
    searchId: r.search_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastContactedAt: r.last_contacted_at,
    emailStatus: (r.email_status as EmailStatus | null) ?? null,
    emailCheckedAt: r.email_checked_at ?? null,
  };
}

export interface NewLead {
  placeId?: string | null;
  name?: string | null;
  businessName: string;
  phoneRaw?: string | null;
  phone?: string | null;
  phoneType?: PhoneType;
  email?: string | null;
  allEmails?: string[];
  website?: string | null;
  domain?: string | null;
  address?: string | null;
  rating?: number | null;
  ratingCount?: number | null;
  mapsUrl?: string | null;
  source: string;
  sources?: string[];
  locationQuery?: string | null;
  propertyTypes?: PropertyType[];
  reraNumber?: string | null;
  notes?: string | null;
  searchId?: number | null;
}

export function insertLead(l: NewLead): Lead {
  const t = now();
  const info = db
    .prepare(
      `INSERT INTO leads (place_id, name, business_name, phone_raw, phone_e164, phone_type, email, all_emails, website, domain,
         address, rating, rating_count, maps_url, source, sources, location_query, property_types, rera_number, notes, search_id,
         created_at, updated_at)
       VALUES (@placeId, @name, @businessName, @phoneRaw, @phone, @phoneType, @email, @allEmails, @website, @domain,
         @address, @rating, @ratingCount, @mapsUrl, @source, @sources, @locationQuery, @propertyTypes, @reraNumber, @notes, @searchId,
         @t, @t)`,
    )
    .run({
      placeId: l.placeId ?? null,
      name: l.name ?? null,
      businessName: l.businessName,
      phoneRaw: l.phoneRaw ?? null,
      phone: l.phone ?? null,
      phoneType: l.phoneType ?? 'unknown',
      email: l.email ?? null,
      allEmails: JSON.stringify(l.allEmails ?? (l.email ? [l.email] : [])),
      website: l.website ?? null,
      domain: l.domain ?? null,
      address: l.address ?? null,
      rating: l.rating ?? null,
      ratingCount: l.ratingCount ?? null,
      mapsUrl: l.mapsUrl ?? null,
      source: l.source,
      sources: JSON.stringify(l.sources ?? [l.source]),
      locationQuery: l.locationQuery ?? null,
      propertyTypes: JSON.stringify(l.propertyTypes ?? []),
      reraNumber: l.reraNumber ?? null,
      notes: l.notes ?? null,
      searchId: l.searchId ?? null,
      t,
    });
  return getLead(Number(info.lastInsertRowid))!;
}

export function getLead(id: number): Lead | null {
  const r = db.prepare('SELECT * FROM leads WHERE id = ?').get(id) as LeadRow | undefined;
  return r ? toLead(r) : null;
}

export function listLeads(q: LeadQuery = {}): Lead[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.searchId) {
    where.push('search_id = ?');
    params.push(q.searchId);
  }
  if (q.status) {
    where.push('status = ?');
    params.push(q.status);
  }
  const sql = `SELECT * FROM leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC`;
  return (db.prepare(sql).all(...params) as LeadRow[]).map(toLead);
}

export function getLeads(ids: number[]): Lead[] {
  if (!ids.length) return [];
  const rows = db.prepare(`SELECT * FROM leads WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(ids)) as LeadRow[];
  const byId = new Map(rows.map((r) => [r.id, toLead(r)]));
  return ids.map((id) => byId.get(id)).filter((l): l is Lead => Boolean(l));
}

const COLUMN: Record<string, string> = {
  name: 'name',
  email: 'email',
  allEmails: 'all_emails',
  notes: 'notes',
  status: 'status',
  reraNumber: 'rera_number',
  sources: 'sources',
  lastContactedAt: 'last_contacted_at',
};

export function updateLead(id: number, patch: Partial<Pick<Lead, 'name' | 'email' | 'allEmails' | 'notes' | 'status' | 'reraNumber' | 'sources' | 'lastContactedAt'>>) {
  const sets: string[] = [];
  const params: Record<string, unknown> = { id, t: now() };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || !COLUMN[k]) continue;
    sets.push(`${COLUMN[k]} = @${k}`);
    params[k] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  if (!sets.length) return getLead(id);
  // A new address needs a fresh check.
  if (patch.email !== undefined) sets.push('email_status = NULL', 'email_checked_at = NULL');
  db.prepare(`UPDATE leads SET ${sets.join(', ')}, updated_at = @t WHERE id = @id`).run(params);
  if (patch.status === 'Do Not Contact') suppressLead(id, 'Marked Do Not Contact');
  return getLead(id);
}

/**
 * Re-checks emails that were found on lead websites (Google sources only; emails the user typed or
 * imported are left alone). Drops addresses that don't belong to the business. Returns leads changed.
 */
export function cleanEnrichedEmails(keep: (email: string, domain: string | null) => boolean, tidy: (email: string) => string): number {
  const rows = db
    .prepare(`SELECT id, email, all_emails, domain FROM leads WHERE email IS NOT NULL AND source IN ('google_places', 'maps_browser')`)
    .all() as { id: number; email: string; all_emails: string; domain: string | null }[];
  const upd = db.prepare('UPDATE leads SET email = ?, all_emails = ?, email_status = NULL, email_checked_at = NULL, updated_at = ? WHERE id = ?');
  let changed = 0;
  db.transaction(() => {
    for (const r of rows) {
      const all = [...new Set(json<string[]>(r.all_emails, [r.email]).map(tidy))];
      const kept = [...new Set(all.filter((e) => keep(e, r.domain)))];
      const email = kept.includes(tidy(r.email)) ? tidy(r.email) : kept[0] ?? null;
      if (email === r.email && JSON.stringify(kept) === r.all_emails) continue;
      upd.run(email, JSON.stringify(kept), now(), r.id);
      changed++;
    }
  })();
  return changed;
}

/** Leads whose email hasn't been checked, plus inconclusive checks older than a day. */
export function leadsNeedingEmailCheck(): { id: number; email: string }[] {
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  return db
    .prepare(`SELECT id, email FROM leads WHERE email IS NOT NULL AND (email_status IS NULL OR (email_status = 'unknown' AND email_checked_at < ?))`)
    .all(dayAgo) as { id: number; email: string }[];
}

export function setEmailStatus(id: number, status: EmailStatus) {
  db.prepare('UPDATE leads SET email_status = ?, email_checked_at = ? WHERE id = ?').run(status, now(), id);
}

export function setLeadStatus(ids: number[], status: LeadStatus) {
  const tx = db.transaction(() => ids.reduce((n, id) => (updateLead(id, { status }) ? n + 1 : n), 0));
  return tx();
}

export function deleteLeads(ids: number[]) {
  const info = db.prepare(`DELETE FROM leads WHERE id IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ids));
  return info.changes;
}

/** Look up an existing lead that matches on place id, phone, email or website domain (in that order). */
export function findDuplicate(c: { placeId?: string | null; phone?: string | null; email?: string | null; domain?: string | null }, excludeId?: number) {
  const ex = excludeId ?? -1;
  const q = (col: string, v: string | null | undefined) =>
    v ? (db.prepare(`SELECT id FROM leads WHERE ${col} = ? AND id != ? LIMIT 1`).get(v, ex) as { id: number } | undefined) : undefined;
  return q('place_id', c.placeId) ?? q('phone_e164', c.phone) ?? q('email', c.email) ?? q('domain', c.domain) ?? null;
}

export function knownPlaceIds(): Set<string> {
  const rows = db.prepare('SELECT place_id FROM leads WHERE place_id IS NOT NULL').all() as { place_id: string }[];
  return new Set(rows.map((r) => r.place_id));
}

// ---------------------------------------------------------------------------
// Suppression (Do Not Contact)

function suppressLead(id: number, reason: string) {
  const lead = getLead(id);
  if (!lead) return;
  const emails = new Set([...(lead.allEmails ?? []), lead.email].filter(Boolean) as string[]);
  const stmt = db.prepare('INSERT OR IGNORE INTO suppressions (email, reason, created_at) VALUES (?, ?, ?)');
  for (const e of emails) stmt.run(e.toLowerCase(), reason, now());
  db.prepare(`UPDATE campaign_leads SET status = 'skipped', error = 'Do Not Contact' WHERE lead_id = ? AND status = 'queued'`).run(id);
}

export function isSuppressed(email: string) {
  return Boolean(db.prepare('SELECT 1 FROM suppressions WHERE email = ?').get(email.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Searches

export function createSearch(location: string, requested: number, propertyTypes: PropertyType[]) {
  const info = db
    .prepare('INSERT INTO searches (location, requested, property_types, started_at) VALUES (?, ?, ?, ?)')
    .run(location, requested, JSON.stringify(propertyTypes), now());
  return Number(info.lastInsertRowid);
}

export function finishSearch(id: number, found: number, status: 'done' | 'cancelled' | 'error') {
  db.prepare('UPDATE searches SET found = ?, status = ?, finished_at = ? WHERE id = ?').run(found, status, now(), id);
}

export function listSearches(): SearchSummary[] {
  const rows = db
    .prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM leads l WHERE l.search_id = s.id) AS kept FROM searches s ORDER BY s.id DESC LIMIT 100`,
    )
    .all() as { id: number; location: string; requested: number; kept: number; property_types: string; status: string; started_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    location: r.location,
    requested: r.requested,
    found: r.kept,
    propertyTypes: json<PropertyType[]>(r.property_types, []),
    status: r.status,
    startedAt: r.started_at,
  }));
}

// ---------------------------------------------------------------------------
// RERA registry

export interface ReraAgent {
  regNumber: string;
  name: string | null;
  businessName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  district: string | null;
  state: string | null;
}

export function upsertReraAgents(agents: ReraAgent[]) {
  const stmt = db.prepare(
    `INSERT INTO rera_agents (reg_number, name, business_name, phone_e164, email, address, district, state, imported_at)
     VALUES (@regNumber, @name, @businessName, @phone, @email, @address, @district, @state, @t)
     ON CONFLICT(reg_number) DO UPDATE SET name = excluded.name, business_name = excluded.business_name,
       phone_e164 = excluded.phone_e164, email = excluded.email, address = excluded.address,
       district = excluded.district, state = excluded.state, imported_at = excluded.imported_at`,
  );
  const t = now();
  db.transaction(() => agents.forEach((a) => stmt.run({ ...a, t })))();
}

type ReraRow = { reg_number: string; name: string | null; business_name: string | null; phone_e164: string | null; email: string | null; address: string | null; district: string | null; state: string | null };
const toAgent = (r: ReraRow): ReraAgent => ({
  regNumber: r.reg_number,
  name: r.name,
  businessName: r.business_name,
  phone: r.phone_e164,
  email: r.email,
  address: r.address,
  district: r.district,
  state: r.state,
});

export function findReraAgent(c: { phone?: string | null; email?: string | null; name?: string | null }): ReraAgent | null {
  const by = (sql: string, v: string | null | undefined) => (v ? (db.prepare(sql).get(v) as ReraRow | undefined) : undefined);
  const r =
    by('SELECT * FROM rera_agents WHERE phone_e164 = ? LIMIT 1', c.phone) ??
    by('SELECT * FROM rera_agents WHERE lower(email) = lower(?) LIMIT 1', c.email) ??
    (c.name ? (db.prepare('SELECT * FROM rera_agents WHERE lower(business_name) = lower(@n) OR lower(name) = lower(@n) LIMIT 1').get({ n: c.name }) as ReraRow | undefined) : undefined);
  return r ? toAgent(r) : null;
}

/** Registry rows whose address or district mentions every word of the location. */
export function searchReraAgents(location: string, limit: number): ReraAgent[] {
  const words = location
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((w) => w.length > 2);
  if (!words.length) return [];
  const where = words.map(() => `(lower(coalesce(address,'') || ' ' || coalesce(district,'')) LIKE ?)`).join(' AND ');
  const rows = db.prepare(`SELECT * FROM rera_agents WHERE ${where} LIMIT ?`).all(...words.map((w) => `%${w}%`), limit) as ReraRow[];
  return rows.map(toAgent);
}

export function reraStats(): ReraStats {
  const a = db.prepare('SELECT COUNT(*) AS n, MAX(imported_at) AS last FROM rera_agents').get() as { n: number; last: string | null };
  const t = db.prepare('SELECT COUNT(*) AS n FROM leads WHERE rera_number IS NOT NULL').get() as { n: number };
  return { agents: a.n, taggedLeads: t.n, lastImport: a.last };
}

export function clearRera() {
  db.prepare('DELETE FROM rera_agents').run();
}

/** Tag every lead that matches a registry row. Returns how many leads were newly tagged. */
export function tagLeadsWithRera(): number {
  const leads = db.prepare('SELECT id, phone_e164, email, business_name, name FROM leads WHERE rera_number IS NULL').all() as {
    id: number;
    phone_e164: string | null;
    email: string | null;
    business_name: string;
    name: string | null;
  }[];
  let tagged = 0;
  const upd = db.prepare('UPDATE leads SET rera_number = ?, updated_at = ? WHERE id = ?');
  db.transaction(() => {
    for (const l of leads) {
      const agent = findReraAgent({ phone: l.phone_e164, email: l.email, name: l.business_name }) ?? (l.name ? findReraAgent({ name: l.name }) : null);
      if (agent) {
        upd.run(agent.regNumber, now(), l.id);
        tagged++;
      }
    }
  })();
  return tagged;
}

// ---------------------------------------------------------------------------
// Templates

type TemplateRow = { id: number; name: string; subject: string; body: string; created_at: string; updated_at: string };
const toTemplate = (r: TemplateRow): EmailTemplate => ({ id: r.id, name: r.name, subject: r.subject, body: r.body, createdAt: r.created_at, updatedAt: r.updated_at });

export function listTemplates(): EmailTemplate[] {
  return (db.prepare('SELECT * FROM templates ORDER BY id').all() as TemplateRow[]).map(toTemplate);
}

export function getTemplate(id: number): EmailTemplate | null {
  const r = db.prepare('SELECT * FROM templates WHERE id = ?').get(id) as TemplateRow | undefined;
  return r ? toTemplate(r) : null;
}

export function saveTemplate(t: { id?: number; name: string; subject: string; body: string }): EmailTemplate {
  const ts = now();
  if (t.id) {
    db.prepare('UPDATE templates SET name = ?, subject = ?, body = ?, updated_at = ? WHERE id = ?').run(t.name, t.subject, t.body, ts, t.id);
    return getTemplate(t.id)!;
  }
  const info = db.prepare('INSERT INTO templates (name, subject, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(t.name, t.subject, t.body, ts, ts);
  return getTemplate(Number(info.lastInsertRowid))!;
}

export function deleteTemplate(id: number) {
  db.prepare('DELETE FROM templates WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Campaigns

type CampaignRow = { id: number; name: string; template_id: number | null; status: string; status_note: string | null; created_at: string };

function campaignCounts(id: number): Record<CampaignLeadStatus, number> {
  const counts: Record<CampaignLeadStatus, number> = { queued: 0, sent: 0, failed: 0, skipped: 0 };
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM campaign_leads WHERE campaign_id = ? GROUP BY status').all(id) as { status: CampaignLeadStatus; n: number }[];
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

const toCampaign = (r: CampaignRow): Campaign => ({
  id: r.id,
  name: r.name,
  templateId: r.template_id,
  status: r.status as CampaignStatus,
  statusNote: r.status_note,
  createdAt: r.created_at,
  counts: campaignCounts(r.id),
});

export function listCampaigns(): Campaign[] {
  return (db.prepare('SELECT * FROM campaigns ORDER BY id DESC').all() as CampaignRow[]).map(toCampaign);
}

export function getCampaign(id: number): Campaign | null {
  const r = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(id) as CampaignRow | undefined;
  return r ? toCampaign(r) : null;
}

export function getCampaignDetail(id: number, whatsapp: (l: Lead) => string | null): CampaignDetail | null {
  const c = getCampaign(id);
  if (!c) return null;
  const rows = db
    .prepare(
      `SELECT cl.status AS cl_status, cl.error, cl.sent_at, l.* FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ? ORDER BY cl.position, l.id`,
    )
    .all(id) as (LeadRow & { cl_status: CampaignLeadStatus; error: string | null; sent_at: string | null })[];
  const leads: CampaignLead[] = rows.map((r) => {
    const lead = toLead(r);
    return {
      leadId: lead.id,
      businessName: lead.businessName,
      name: lead.name,
      email: lead.email,
      phone: lead.phone,
      phoneType: lead.phoneType,
      leadStatus: lead.status,
      status: r.cl_status,
      error: r.error,
      sentAt: r.sent_at,
      whatsappUrl: whatsapp(lead),
    };
  });
  return { ...c, leads };
}

export function createCampaign(name: string, templateId: number | null): Campaign {
  const info = db.prepare('INSERT INTO campaigns (name, template_id, created_at) VALUES (?, ?, ?)').run(name, templateId, now());
  return getCampaign(Number(info.lastInsertRowid))!;
}

/** Adds leads to a campaign. Leads marked Do Not Contact (or whose email is suppressed) are never added. */
export function addCampaignLeads(campaignId: number, leadIds: number[]) {
  let added = 0;
  let excluded = 0;
  const maxPos = (db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM campaign_leads WHERE campaign_id = ?').get(campaignId) as { p: number }).p;
  const ins = db.prepare('INSERT OR IGNORE INTO campaign_leads (campaign_id, lead_id, position) VALUES (?, ?, ?)');
  db.transaction(() => {
    getLeads(leadIds).forEach((l, i) => {
      if (l.status === 'Do Not Contact' || (l.email && isSuppressed(l.email))) {
        excluded++;
        return;
      }
      added += ins.run(campaignId, l.id, maxPos + i + 1).changes;
    });
  })();
  return { added, excluded };
}

export function updateCampaign(id: number, patch: { name?: string; templateId?: number | null; status?: CampaignStatus; statusNote?: string | null }) {
  const c = getCampaign(id);
  if (!c) return null;
  db.prepare('UPDATE campaigns SET name = ?, template_id = ?, status = ?, status_note = ? WHERE id = ?').run(
    patch.name ?? c.name,
    patch.templateId !== undefined ? patch.templateId : c.templateId,
    patch.status ?? c.status,
    patch.statusNote !== undefined ? patch.statusNote : c.statusNote,
    id,
  );
  return getCampaign(id);
}

export function deleteCampaign(id: number) {
  db.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
}

export function nextQueuedLead(campaignId: number): Lead | null {
  const r = db
    .prepare(
      `SELECT l.* FROM campaign_leads cl JOIN leads l ON l.id = cl.lead_id
       WHERE cl.campaign_id = ? AND cl.status = 'queued' ORDER BY cl.position, l.id LIMIT 1`,
    )
    .get(campaignId) as LeadRow | undefined;
  return r ? toLead(r) : null;
}

export function markCampaignLead(campaignId: number, leadId: number, status: CampaignLeadStatus, error: string | null = null) {
  db.prepare('UPDATE campaign_leads SET status = ?, error = ?, sent_at = ? WHERE campaign_id = ? AND lead_id = ?').run(
    status,
    error,
    status === 'sent' ? now() : null,
    campaignId,
    leadId,
  );
}

export function runningCampaigns(): Campaign[] {
  return (db.prepare(`SELECT * FROM campaigns WHERE status = 'running' ORDER BY id`).all() as CampaignRow[]).map(toCampaign);
}

// ---------------------------------------------------------------------------
// Email log (for the daily cap)

export function logEmail(e: { leadId: number | null; campaignId: number | null; to: string; subject: string; messageId: string | null }) {
  db.prepare('INSERT INTO email_log (lead_id, campaign_id, to_email, subject, message_id, sent_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    e.leadId,
    e.campaignId,
    e.to,
    e.subject,
    e.messageId,
    now(),
  );
}

/** Emails sent since local midnight. */
export function sentToday(): number {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return (db.prepare('SELECT COUNT(*) AS n FROM email_log WHERE sent_at >= ?').get(midnight.toISOString()) as { n: number }).n;
}
