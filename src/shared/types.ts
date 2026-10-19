/**
 * Types shared by the Electron main process, the preload bridge and the React UI.
 * Every IPC channel is listed in `IpcApi` so both sides stay in sync.
 */

export const PROPERTY_TYPES = ['Plots', 'Houses', 'Flats', 'Bungalows', 'Commercial'] as const;
export type PropertyType = (typeof PROPERTY_TYPES)[number];

export const LEAD_STATUSES = ['New', 'Contacted', 'Replied', 'Interested', 'Not Interested', 'Do Not Contact'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type PhoneType = 'mobile' | 'landline' | 'unknown';

export interface Lead {
  id: number;
  placeId: string | null;
  name: string | null; // contact person, when a source provides one
  businessName: string;
  phone: string | null; // E.164, e.g. +919812345678
  phoneRaw: string | null;
  phoneType: PhoneType;
  email: string | null;
  allEmails: string[];
  website: string | null;
  domain: string | null;
  address: string | null;
  rating: number | null;
  ratingCount: number | null;
  mapsUrl: string | null;
  source: string; // primary source id, e.g. "google_places"
  sources: string[];
  locationQuery: string | null;
  propertyTypes: PropertyType[];
  reraNumber: string | null;
  status: LeadStatus;
  notes: string | null;
  searchId: number | null;
  createdAt: string; // ISO
  updatedAt: string;
  lastContactedAt: string | null;
  /** Result of checking that the email's domain accepts mail; null until checked. */
  emailStatus: EmailStatus | null;
  emailCheckedAt: string | null;
}

/**
 * verified: the domain publishes mail servers, so mail to it can be delivered.
 * invalid: the domain doesn't exist or accepts no mail — sending would bounce.
 * unknown: the check couldn't finish (offline, DNS timeout); retried later.
 */
export type EmailStatus = 'verified' | 'invalid' | 'unknown';

export interface SearchFilters {
  propertyTypes: PropertyType[];
  /** Sources to use; defaults to every enabled source. */
  sources?: string[];
  radiusKm?: number;
  enrichEmails?: boolean;
}

export interface SearchRequest {
  location: string;
  limit: number;
  filters: SearchFilters;
}

export type SearchPhase = 'starting' | 'searching' | 'saving' | 'enriching' | 'done' | 'cancelled' | 'error';

export interface SearchProgress {
  searchId: number;
  phase: SearchPhase;
  message: string;
  found: number;
  requested: number;
  /** 0–100 */
  percent: number;
}

export interface SearchResult {
  searchId: number;
  requested: number;
  found: number;
  cancelled: boolean;
  leads: Lead[];
  warnings: string[];
  error?: AppError;
}

export interface SearchSummary {
  id: number;
  location: string;
  requested: number;
  found: number;
  propertyTypes: PropertyType[];
  status: string;
  startedAt: string;
}

export type AppErrorCode =
  | 'NO_API_KEY'
  | 'INVALID_API_KEY'
  | 'API_NOT_ENABLED'
  | 'QUOTA_EXCEEDED'
  | 'NETWORK'
  | 'SMTP_NOT_CONFIGURED'
  | 'SMTP_AUTH'
  | 'SECURE_STORAGE_UNAVAILABLE'
  | 'VALIDATION'
  | 'UNKNOWN';

export interface AppError {
  code: AppErrorCode;
  message: string;
}

/** Settings as the renderer sees them. Secrets are never sent back, only whether they are set. */
export interface Settings {
  hasPlacesApiKey: boolean;
  hasSmtpPassword: boolean;
  secureStorageAvailable: boolean;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    fromName: string;
    fromEmail: string;
  };
  /** Seconds between two emails (default 30). */
  emailThrottleSeconds: number;
  dailyEmailCap: number;
  defaultRadiusKm: number;
  /** Minimum delay between two requests to the same website, in ms (never below 1000). */
  perDomainDelayMs: number;
  requestTimeoutMs: number;
  enrichEmailsByDefault: boolean;
  /** "combined": Text Search returns contact fields directly (fewer calls).
   *  "details": Text Search for IDs, then Place Details only for leads not already in the DB. */
  placesMode: 'combined' | 'details';
  maxPagesPerQuery: number;
  /** Look up phone/website on Google Places for builders found in RERA data (1 Places request each). */
  lookupBuilderContacts: boolean;
  /** Optional postal address / signature line appended to emails. */
  senderFooter: string;
}

export interface SettingsUpdate extends Partial<Omit<Settings, 'hasPlacesApiKey' | 'hasSmtpPassword' | 'secureStorageAvailable' | 'smtp'>> {
  smtp?: Partial<Settings['smtp']>;
  /** Set to a string to store, '' to clear, undefined to leave unchanged. */
  placesApiKey?: string;
  smtpPassword?: string;
}

export interface EmailTemplate {
  id: number;
  name: string;
  subject: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export type CampaignStatus = 'draft' | 'running' | 'paused' | 'done';
export type CampaignLeadStatus = 'queued' | 'sent' | 'failed' | 'skipped';

export interface Campaign {
  id: number;
  name: string;
  templateId: number | null;
  status: CampaignStatus;
  statusNote: string | null;
  createdAt: string;
  counts: Record<CampaignLeadStatus, number>;
}

export interface CampaignLead {
  leadId: number;
  businessName: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  phoneType: PhoneType;
  leadStatus: LeadStatus;
  status: CampaignLeadStatus;
  error: string | null;
  sentAt: string | null;
  whatsappUrl: string | null;
}

export interface CampaignDetail extends Campaign {
  leads: CampaignLead[];
}

export interface SenderState {
  running: boolean;
  campaignId: number | null;
  sentToday: number;
  dailyCap: number;
  nextSendAt: string | null;
  message: string;
}

export interface ReraImportResult {
  imported: number;
  skipped: number;
  tagged: number;
  columns: Record<string, string | null>;
}

export interface LeadImportResult {
  imported: number;
  duplicates: number;
  skipped: number;
  tagged: number;
  searchId: number;
  columns: Record<string, string | null>;
}

export interface ReraStats {
  agents: number;
  taggedLeads: number;
  lastImport: string | null;
}

export interface SourceInfo {
  id: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
}

export type ExportFormat = 'csv' | 'xlsx' | 'pdf';

/** Shown at the top of a PDF export so the reader knows what the list is. */
export interface ExportMeta {
  title?: string;
  filters?: string;
}

export interface LeadQuery {
  searchId?: number | null;
  status?: LeadStatus | null;
}

/** A contact read from text the user selected or pasted in the Collector, before it is saved. */
export interface ContactCandidate {
  businessName: string;
  name: string | null;
  phone: string | null; // E.164 when the number validated
  phoneRaw: string | null;
  phoneType: PhoneType;
  email: string | null;
  website: string | null;
  address: string | null;
  reraNumber: string | null;
}

export type CollectorMode = 'portals' | 'rera';

export interface CollectorState {
  mode: CollectorMode;
  location: string;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
  /** Leads saved from this Collector window since it opened. */
  added: number;
}

export interface ReraPageImport {
  agents: number;
  addedLeads: number;
  duplicates: number;
  tagged: number;
  skipped: number;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: AppError };

/** The API exposed on `window.api` by the preload script. */
export interface IpcApi {
  search: {
    start(req: SearchRequest): Promise<Result<SearchResult>>;
    cancel(searchId?: number): Promise<void>;
    onProgress(cb: (p: SearchProgress) => void): () => void;
    list(): Promise<SearchSummary[]>;
    sources(): Promise<SourceInfo[]>;
  };
  leads: {
    list(q?: LeadQuery): Promise<Lead[]>;
    update(id: number, patch: { status?: LeadStatus; notes?: string | null; name?: string | null; email?: string | null }): Promise<Lead | null>;
    setStatus(ids: number[], status: LeadStatus): Promise<number>;
    remove(ids: number[]): Promise<number>;
    export(ids: number[], format: ExportFormat, meta?: ExportMeta): Promise<Result<{ saved: boolean; filePath?: string }>>;
    whatsappLink(id: number, templateId?: number | null): Promise<string | null>;
    importCsv(): Promise<Result<LeadImportResult | null>>;
    add(input: { emails: string; businessName?: string; name?: string; phone?: string; location?: string }): Promise<Result<{ added: number; duplicates: number }>>;
    /** Fires when leads are saved from another window (the Collector). */
    onChanged(cb: () => void): () => void;
  };
  templates: {
    list(): Promise<EmailTemplate[]>;
    save(t: { id?: number; name: string; subject: string; body: string }): Promise<EmailTemplate>;
    remove(id: number): Promise<void>;
    preview(templateId: number, leadId: number): Promise<{ subject: string; text: string } | null>;
    sendTest(templateId: number, leadId: number): Promise<Result<{ message: string }>>;
  };
  campaigns: {
    list(): Promise<Campaign[]>;
    get(id: number): Promise<CampaignDetail | null>;
    create(name: string, templateId: number | null, leadIds: number[]): Promise<Campaign>;
    addLeads(id: number, leadIds: number[]): Promise<{ added: number; excluded: number }>;
    update(id: number, patch: { name?: string; templateId?: number | null }): Promise<Campaign | null>;
    remove(id: number): Promise<void>;
    start(id: number): Promise<Result<SenderState>>;
    pause(id: number): Promise<SenderState>;
    senderState(): Promise<SenderState>;
    onSenderState(cb: (s: SenderState) => void): () => void;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: SettingsUpdate): Promise<Result<Settings>>;
    testPlacesKey(): Promise<Result<{ message: string }>>;
    testSmtp(sendTo?: string): Promise<Result<{ message: string }>>;
  };
  rera: {
    importCsv(): Promise<Result<ReraImportResult | null>>;
    stats(): Promise<ReraStats>;
    clear(): Promise<void>;
  };
  collector: {
    open(mode: CollectorMode, location: string): Promise<void>;
    state(): Promise<CollectorState>;
    onState(cb: (s: CollectorState) => void): () => void;
    setMode(mode: CollectorMode, location: string): Promise<void>;
    navigate(url: string): Promise<void>;
    nav(action: 'back' | 'forward' | 'reload'): Promise<void>;
    readSelection(): Promise<ContactCandidate[]>;
    parse(text: string): Promise<ContactCandidate[]>;
    save(candidates: ContactCandidate[]): Promise<Result<{ added: number; duplicates: number }>>;
    importReraPage(): Promise<Result<ReraPageImport>>;
  };
  shell: {
    openExternal(url: string): Promise<void>;
    copy(text: string): Promise<void>;
  };
}
