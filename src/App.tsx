import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from './api';
import AddLeadModal from './components/AddLeadModal';
import EmailModal, { OUTREACH } from './components/EmailModal';
import { cx } from './components/Modal';
import RegistryModal from './components/RegistryModal';
import SettingsModal from './components/SettingsModal';
import { useFeedback } from './components/Toast';
import {
  LEAD_STATUSES,
  PROPERTY_TYPES,
  type Campaign,
  type CampaignLeadStatus,
  type Lead,
  type LeadStatus,
  type PropertyType,
  type ReraStats,
  type SearchProgress,
  type SearchSummary,
  type SenderState,
  type Settings,
  type SourceInfo,
} from './shared/types';

const SOURCE_LABEL: Record<string, string> = { google_places: 'google', maps_browser: 'google maps', rera: 'rera', reale: 'reale.in', csv_import: 'csv', manual: 'manual', collector: 'collected' };
const SOURCE_SETS: Record<string, string[]> = {
  auto: ['google_places', 'reale', 'rera', 'maps_browser'],
  maps: ['maps_browser'],
  google: ['google_places'],
  rera: ['rera', 'reale'],
};
const IS_MAC = navigator.userAgent.includes('Mac');

const plural = (n: number, w: string) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;

/** How reachable a lead is, 0–100. Shown as a bar so rows compare at a glance. */
function scoreOf(l: Lead) {
  let s = 0;
  if (l.email) s += 35;
  if (l.phone) s += 25;
  if (l.phoneType === 'mobile') s += 10;
  if (l.website) s += 10;
  if (l.reraNumber) s += 15;
  if ((l.rating ?? 0) >= 4) s += 5;
  return s;
}

type PhaseState = 'active' | 'done' | 'err' | null;

/**
 * One screen, laid out like cosci-leads: search form on top, fill-rate stats, run phases,
 * filters, the results table with a detail panel, and the activity log underneath.
 */
export default function App() {
  const { toast, log, lines, clear } = useFeedback();

  // Data
  const [leads, setLeads] = useState<Lead[]>([]);
  const [searches, setSearches] = useState<SearchSummary[]>([]);
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [sendState, setSendState] = useState<Map<number, { status: CampaignLeadStatus; error: string | null }>>(new Map());
  const [settings, setSettings] = useState<Settings | null>(null);
  const [sender, setSender] = useState<SenderState | null>(null);
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [rera, setRera] = useState<ReraStats | null>(null);

  // Search form
  const [location, setLocation] = useState('');
  const [limit, setLimit] = useState(50);
  const [ptype, setPtype] = useState<'any' | 'plots+bungalows' | PropertyType>('plots+bungalows');
  const [sourceSet, setSourceSet] = useState('auto');
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [searching, setSearching] = useState(false);
  const [lastRun, setLastRun] = useState<{ searchId: number; found: number; requested: number; usedGoogle: boolean } | null>(null);

  // Table filters
  const [searchFilter, setSearchFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  // On by default: only agents you can both call and email. Remembered between sessions.
  const [onlyComplete, setOnlyComplete] = useState(() => {
    try {
      return localStorage.getItem('onlyComplete') !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('onlyComplete', onlyComplete ? '1' : '0');
    } catch {
      /* storage unavailable: keep the default */
    }
  }, [onlyComplete]);
  const [onlyVerified, setOnlyVerified] = useState(() => {
    try {
      return localStorage.getItem('onlyVerified') !== '0';
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('onlyVerified', onlyVerified ? '1' : '0');
    } catch {
      /* storage unavailable: keep the default */
    }
  }, [onlyVerified]);
  const [onlyMobile, setOnlyMobile] = useState(false);
  const [onlyRera, setOnlyRera] = useState(false);
  const [hideContacted, setHideContacted] = useState(false);
  const [sort, setSort] = useState<'score' | 'newest'>('score');
  const [text, setText] = useState('');
  const [selectedId, setSelectedId] = useState<number | null>(null);

  // Log panel
  const [follow, setFollow] = useState(true);
  const [logHidden, setLogHidden] = useState(false);

  const [modal, setModal] = useState<'settings' | 'registry' | 'email' | 'add' | null>(null);

  const outreach = campaigns.find((c) => c.name === OUTREACH) ?? null;

  const loadLeads = useCallback(
    () =>
      api.leads
        .list({ searchId: searchFilter === 'all' ? null : Number(searchFilter), status: statusFilter === 'all' ? null : (statusFilter as LeadStatus) })
        .then(setLeads),
    [searchFilter, statusFilter],
  );

  const loadCampaigns = useCallback(async () => {
    const cs = await api.campaigns.list();
    setCampaigns(cs);
    const c = cs.find((x) => x.name === OUTREACH);
    const detail = c ? await api.campaigns.get(c.id) : null;
    setSendState(new Map((detail?.leads ?? []).map((l) => [l.leadId, { status: l.status, error: l.error }])));
  }, []);

  const loadRera = useCallback(() => api.rera.stats().then(setRera), []);

  const reloadAll = useCallback(() => {
    loadLeads();
    loadCampaigns();
    loadRera();
    api.search.list().then(setSearches);
  }, [loadLeads, loadCampaigns, loadRera]);

  useEffect(() => {
    api.settings.get().then(setSettings);
    api.search.sources().then(setSources);
    api.search.list().then(setSearches);
    api.campaigns.senderState().then(setSender);
    loadCampaigns();
    loadRera();
    log('PropLeads ready.', 'system');
    const offProgress = api.search.onProgress((p) => {
      setProgress(p);
      log(p.message, p.phase === 'error' ? 'error' : p.phase === 'done' ? 'ok' : 'info');
    });
    const offSender = api.campaigns.onSenderState((s) => {
      setSender(s);
      log(`[email] ${s.message}`, /fail|error|cap reached|paused/i.test(s.message) ? 'warn' : /^Sent/.test(s.message) ? 'ok' : 'info');
      loadCampaigns();
      loadLeads();
    });
    const offChanged = api.leads.onChanged(() => reloadRef.current());
    return () => {
      offProgress();
      offSender();
      offChanged();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadLeads();
  }, [loadLeads]);

  // The Collector window saves leads while this window is open; keep the table current.
  const reloadRef = useRef(reloadAll);
  reloadRef.current = reloadAll;

  // Source availability follows the Places key; refresh when Settings change.
  useEffect(() => {
    api.search.sources().then(setSources);
  }, [settings?.hasPlacesApiKey]);

  // ---------------------------------------------------------------- table --
  const shown = useMemo(() => {
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const rows = leads.filter((l) => {
      if (onlyComplete && !(l.email && l.phone)) return false;
      if (onlyVerified && l.email && l.emailStatus !== 'verified') return false;
      if (onlyMobile && l.phoneType !== 'mobile') return false;
      if (onlyRera && !l.reraNumber) return false;
      if (hideContacted && l.status !== 'New') return false;
      if (!words.length) return true;
      const hay = [l.name, l.businessName, l.phone, l.phoneRaw, l.email, l.website, l.address, l.locationQuery, l.reraNumber, l.status, l.notes].join(' ').toLowerCase();
      return words.every((w) => hay.includes(w));
    });
    if (sort === 'score') rows.sort((a, b) => scoreOf(b) - scoreOf(a) || a.businessName.localeCompare(b.businessName));
    return rows;
  }, [leads, text, onlyComplete, onlyVerified, onlyMobile, onlyRera, hideContacted, sort]);

  const selected = leads.find((l) => l.id === selectedId) ?? null;
  const sendable = shown.filter((l) => l.email && l.status === 'New' && !sendState.has(l.id));
  const totals = campaigns.reduce((a, c) => ({ sent: a.sent + c.counts.sent, failed: a.failed + c.counts.failed }), { sent: 0, failed: 0 });

  const stats = useMemo(() => {
    const n = leads.length;
    const c = (f: (l: Lead) => boolean) => leads.filter(f).length;
    return {
      total: n,
      email: c((l) => Boolean(l.email)),
      phone: c((l) => Boolean(l.phone)),
      mobile: c((l) => l.phoneType === 'mobile'),
      rera: c((l) => Boolean(l.reraNumber)),
      verified: c((l) => l.emailStatus === 'verified'),
      pct: (k: number) => (n ? `${Math.round((100 * k) / n)}% of ${n}` : '—'),
    };
  }, [leads]);

  function patchLead(updated: Lead | null) {
    if (updated) setLeads((xs) => xs.map((x) => (x.id === updated.id ? updated : x)));
  }

  async function setStatus(lead: Lead, status: LeadStatus) {
    patchLead(await api.leads.update(lead.id, { status }));
    log(`${lead.businessName} → ${status}`);
    if (status === 'Do Not Contact') toast(`${lead.businessName} will never be emailed.`);
  }

  async function openWhatsApp(lead: Lead) {
    const url = await api.leads.whatsappLink(lead.id, outreach?.templateId ?? null);
    if (!url) return;
    await api.shell.openExternal(url);
    log(`Opened WhatsApp for ${lead.businessName}`);
    if (lead.status === 'New') setStatus(lead, 'Contacted');
  }

  async function removeLead(lead: Lead) {
    if (!confirm(`Delete ${lead.businessName}? This can't be undone.`)) return;
    await api.leads.remove([lead.id]);
    log(`Deleted ${lead.businessName}`);
    setSelectedId(null);
    reloadAll();
  }

  const openCollector = (mode: 'portals' | 'rera') => api.collector.open(mode, location.trim() || searchLabel?.location || '');

  const copy = (value: string) => api.shell.copy(value).then(() => toast(`Copied ${value}`));

  // --------------------------------------------------------------- search --
  async function startSearch(e?: FormEvent) {
    e?.preventDefault();
    if (searching) return;
    if (!location.trim()) return toast('Enter a location first, e.g. "Baner, Pune".', 'error');
    // With an API key, Auto uses it; without one, the free Maps browser source stands in.
    const wanted = SOURCE_SETS[sourceSet].filter((id) => sources.find((s) => s.id === id)?.available && !(sourceSet === 'auto' && id === 'maps_browser' && googleOk));
    if (!wanted.length) {
      return toast(sourceSet === 'google' ? 'Add your Google Places API key in Settings first.' : 'None of those sources are available. Check Settings.', 'error');
    }
    setSearching(true);
    setProgress(null);
    setSelectedId(null);
    log(`Searching ${location.trim()} for ${limit} leads…`, 'system');
    const res = await api.search.start({
      location,
      limit,
      filters: {
        propertyTypes: ptype === 'any' ? [] : ptype === 'plots+bungalows' ? ['Plots', 'Bungalows'] : [ptype],
        sources: wanted,
        radiusKm: settings?.defaultRadiusKm,
        enrichEmails: settings?.enrichEmailsByDefault ?? true,
      },
    });
    setSearching(false);
    if (!res.ok) return toast(res.error.message, 'error');
    const r = res.data;
    setLastRun({ searchId: r.searchId, found: r.found, requested: r.requested, usedGoogle: wanted.includes('google_places') || wanted.includes('maps_browser') });
    r.warnings.forEach((w) => log(w, 'warn'));
    if (r.error) toast(r.error.message, 'error');
    else if (r.cancelled) toast(`Stopped. Kept ${plural(r.found, 'lead')}.`);
    else {
      const msg = r.found < r.requested ? `Found ${r.found} of ${r.requested} requested` : `Found ${plural(r.found, 'new lead')}`;
      toast(msg, r.found ? 'ok' : 'warn');
    }
    setSearchFilter(String(r.searchId));
    setStatusFilter('all');
    reloadAll();
  }

  // ----------------------------------------------------------- toolbar acts --
  async function importCsv() {
    const res = await api.leads.importCsv();
    if (!res.ok) return toast(res.error.message, 'error');
    if (!res.data) return;
    const d = res.data;
    toast(`Imported ${plural(d.imported, 'lead')}. ${d.duplicates} duplicates and ${d.skipped} rows without contact details skipped.`, 'ok');
    setSearchFilter(String(d.searchId));
    reloadAll();
  }

  async function exportLeads(format: 'csv' | 'xlsx' | 'pdf') {
    if (!shown.length) return toast('Nothing to export.');
    // The PDF says what the list is, so it makes sense to whoever receives it.
    const title = `Real estate agents — ${searchLabel?.location ?? 'all areas'}`;
    const filters = [
      onlyComplete && 'with email and phone',
      onlyVerified && 'verified emails only',
      onlyMobile && 'mobile numbers only',
      onlyRera && 'RERA registered only',
      hideContacted && 'not yet contacted',
      statusFilter !== 'all' && `status: ${statusFilter}`,
      text.trim() && `matching “${text.trim()}”`,
    ]
      .filter(Boolean)
      .join(', ');
    const res = await api.leads.export(shown.map((l) => l.id), format, { title, filters });
    if (!res.ok) toast(res.error.message, 'error');
    else if (res.data.saved) toast(`Exported ${plural(shown.length, 'lead')} → ${res.data.filePath}`, 'ok');
  }

  // --------------------------------------------------------------- phases --
  const ph = progress?.phase;
  const phases: { id: string; label: string; state: PhaseState }[] = [
    {
      id: 'search',
      label: 'search',
      state: !progress ? null : ph === 'starting' || ph === 'searching' || ph === 'saving' ? 'active' : !progress.found ? 'err' : 'done',
    },
    { id: 'emails', label: 'emails', state: ph === 'enriching' ? 'active' : (ph === 'done' || ph === 'cancelled') && progress?.found ? 'done' : null },
    { id: 'saved', label: 'saved', state: ph === 'done' && progress?.found ? 'done' : ph === 'error' || ph === 'cancelled' ? 'err' : null },
    { id: 'send', label: 'sending', state: sender?.running ? 'active' : outreach?.status === 'done' ? 'done' : outreach?.status === 'paused' && outreach.statusNote !== 'Paused' ? 'err' : null },
  ];
  const statusMsg = searching
    ? progress?.message ?? 'Starting search…'
    : sender?.running
      ? sender.message
      : progress
        ? progress.message
        : leads.length || searchFilter !== 'all'
          ? `${plural(leads.length, 'lead')} · ${sender ? `${sender.sentToday} of ${sender.dailyCap} emails sent today` : ''}`
          : 'Idle';
  const searchLabel = searches.find((s) => String(s.id) === searchFilter);
  const googleOk = Boolean(sources.find((s) => s.id === 'google_places')?.available);
  const working = searching || Boolean(sender?.running);

  return (
    <>
      <header className="topbar" style={IS_MAC ? undefined : { paddingLeft: 14 }}>
        <div className="brand">
          PropLeads <span>{searchLabel ? searchLabel.location : 'real estate agents & brokers'}</span>
        </div>
        <div className="spacer" />
        <button className="registry" onClick={() => setModal('registry')} title="RERA agent registry">
          <span className={cx('dot', rera?.agents ? 'ok' : 'idle')} />
          <span>{rera?.agents ? <>registry <b>{rera.agents.toLocaleString()}</b></> : 'registry —'}</span>
        </button>
        <button className="registry" onClick={() => setModal('email')} title="Email outreach">
          <span className={cx('dot', sender?.running ? 'ok' : outreach?.counts.queued ? 'idle' : '')} />
          <span>{sender?.running ? 'sending…' : <>email <b>{totals.sent}</b> sent</>}</span>
        </button>
        <button className="ghost" onClick={() => setModal('settings')}>
          Settings
        </button>
      </header>

      <form className="searchbar" onSubmit={startSearch}>
        <div className="field location">
          <label htmlFor="location">Locality, city</label>
          <input id="location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Baner, Pune · Andheri West, Mumbai…" list="recentLocations" autoComplete="off" disabled={searching} />
          <datalist id="recentLocations">
            {[...new Set(searches.map((s) => s.location))].slice(0, 20).map((l) => (
              <option key={l} value={l} />
            ))}
          </datalist>
        </div>
        <div className="field count">
          <label htmlFor="limit">Leads</label>
          <input id="limit" className="mono" type="number" min={1} max={1000} value={limit} disabled={searching} onChange={(e) => setLimit(Math.max(1, Math.min(1000, Number(e.target.value) || 1)))} />
        </div>
        <div className="field ptype">
          <label htmlFor="ptype">Property type</label>
          <select id="ptype" value={ptype} onChange={(e) => setPtype(e.target.value as typeof ptype)} disabled={searching}>
            <option value="plots+bungalows">Plots + Bungalows</option>
            <option value="any">Any</option>
            {PROPERTY_TYPES.map((t) => (
              <option key={t}>{t}</option>
            ))}
          </select>
        </div>
        <div className="field source">
          <label htmlFor="source">Sources</label>
          <select id="source" value={sourceSet} onChange={(e) => setSourceSet(e.target.value)} disabled={searching}>
            <option value="auto">{googleOk ? 'Auto (RERA → Google API)' : 'Auto (RERA → Google Maps)'}</option>
            <option value="maps">Google Maps (free, no key)</option>
            <option value="google" disabled={!googleOk}>
              Google Places API{googleOk ? '' : ' (add key)'}
            </option>
            <option value="rera">RERA lists only</option>
          </select>
        </div>
        <div className="go">
          <button type="submit" className="primary" disabled={searching}>
            {searching ? 'Working…' : 'Find leads'}
          </button>
          <button type="button" className="danger" disabled={!searching} onClick={() => api.search.cancel(progress?.searchId)}>
            Stop
          </button>
        </div>
      </form>

      <section className={cx('stats', leads.length > 0 && 'show')}>
        <div className="stat hero">
          <div className="k">Verified email</div>
          <div className="v mono">{stats.verified}</div>
          <div className="sub">{stats.pct(stats.verified)}</div>
        </div>
        <div className="stat">
          <div className="k">Any email</div>
          <div className="v mono">{stats.email}</div>
          <div className="sub">{stats.pct(stats.email)}</div>
        </div>
        <div className="stat">
          <div className="k">With phone</div>
          <div className="v mono">{stats.phone}</div>
          <div className="sub">callable</div>
        </div>
        <div className="stat">
          <div className="k">Mobile</div>
          <div className="v mono">{stats.mobile}</div>
          <div className="sub">WhatsApp-able</div>
        </div>
        <div className="stat">
          <div className="k">RERA verified</div>
          <div className="v mono">{stats.rera}</div>
          <div className="sub">registered agents</div>
        </div>
        <div className="stat">
          <div className="k">Total leads</div>
          <div className="v mono">{stats.total}</div>
          <div className="sub">{searchLabel ? 'in this search' : 'saved'}</div>
        </div>
      </section>

      <section className="statusbar">
        {phases.map((p) => (
          <span key={p.id} className={cx('phase', p.state)}>
            {p.label}
          </span>
        ))}
        <span className="statusmsg" title={statusMsg}>
          {statusMsg}
        </span>
      </section>
      <div className={cx('progress', working && 'on')}>
        <div className="bar" />
      </div>

      <section className="toolbar">
        <label className="toggle" title="Only agents with both an email address and a phone number">
          <input type="checkbox" checked={onlyComplete} onChange={(e) => setOnlyComplete(e.target.checked)} /> Email + phone
        </label>
        <label className="toggle" title="Hide emails whose domain doesn't accept mail, or that haven't been checked yet">
          <input type="checkbox" checked={onlyVerified} onChange={(e) => setOnlyVerified(e.target.checked)} /> Verified email
        </label>
        <label className="toggle" title="Mobile numbers can be opened in WhatsApp">
          <input type="checkbox" checked={onlyMobile} onChange={(e) => setOnlyMobile(e.target.checked)} /> Mobile only
        </label>
        <label className="toggle">
          <input type="checkbox" checked={onlyRera} onChange={(e) => setOnlyRera(e.target.checked)} /> RERA only
        </label>
        <label className="toggle" title="Hide leads you have already contacted or marked">
          <input type="checkbox" checked={hideContacted} onChange={(e) => setHideContacted(e.target.checked)} /> New only
        </label>
        <span className="sep" />
        <select className="sm" value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} title="Show leads from one search">
          <option value="all">All searches</option>
          {searches.map((s) => (
            <option key={s.id} value={s.id}>
              {s.location} · {new Date(s.startedAt).toLocaleDateString()} ({s.found})
            </option>
          ))}
        </select>
        <select className="sm" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
          <option value="all">Any status</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
        <select className="sm" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}>
          <option value="score">Best first</option>
          <option value="newest">Newest first</option>
        </select>
        <input className="search" value={text} onChange={(e) => setText(e.target.value)} placeholder="Filter by name, phone, email, address…" autoComplete="off" />
        <span className="count-note">
          {shown.length === leads.length ? `${shown.length} shown` : `${shown.length} shown · ${leads.length} total`}
        </span>
        <button className="sm" onClick={() => setModal('add')}>
          Add
        </button>
        <button className="sm" onClick={importCsv} title="Import contacts collected from portals, directories or RERA exports">
          Import
        </button>
        <button className="sm" onClick={() => openCollector('portals')} title="Open Justdial, 99acres, Magicbricks, Google Maps… inside PropLeads and add agents from them">
          Collect from sites
        </button>
        <button className="sm primary" onClick={() => exportLeads('pdf')} title="A PDF of the agents shown, ready to send to someone">
          Download PDF
        </button>
        <button className="sm" onClick={() => exportLeads('csv')}>
          Export CSV
        </button>
        <button className="sm" onClick={() => exportLeads('xlsx')}>
          Excel
        </button>
      </section>

      <section className="main">
        <div className="tablewrap">
          {shown.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Agent name</th>
                  <th className="c-phone">Phone number</th>
                  <th className="c-mail">Email</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((l) => (
                  <LeadRow key={l.id} lead={l} selected={l.id === selectedId} onClick={() => setSelectedId(l.id)} />
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">
              {searching ? (
                <>
                  <h3>Searching…</h3>
                  <p>Reading the RERA lists, then Google Maps listing by listing, then checking websites for emails.<br />The free Google Maps search goes at a human pace: about 50 agents in 2–3 minutes.</p>
                </>
              ) : !leads.length && searchFilter !== 'all' && (lastRun && String(lastRun.searchId) === searchFilter ? !lastRun.usedGoogle : !googleOk) ? (
                <>
                  <h3>No leads found for “{searchLabel?.location}”</h3>
                  <p>
                    Only the RERA lists were searched, because {settings?.hasPlacesApiKey ? 'Google Maps was not selected in Sources' : 'no Google Places API key is saved'}.
                    <br />
                    reale.in only covers Rajasthan, Haryana, Kerala, Telangana, Bihar, Odisha, Jharkhand and Himachal Pradesh,
                    <br />
                    so cities like Mumbai or Pune return nothing from it.
                  </p>
                  <div className="emptyacts">
                    {settings?.hasPlacesApiKey ? (
                      <button className="primary" onClick={() => setSourceSet('auto')}>
                        Use all sources
                      </button>
                    ) : (
                      <button className="primary" onClick={() => setModal('settings')}>
                        Add Google Places key
                      </button>
                    )}
                    <button onClick={() => openCollector('rera')}>Open RERA browser</button>
                    <button onClick={() => openCollector('portals')}>Collect from sites</button>
                  </div>
                </>
              ) : !leads.length && searchFilter !== 'all' ? (
                <>
                  <h3>No new leads in this search</h3>
                  <p>
                    Leads you already have are skipped, so a repeat search can come back empty.
                    <br />
                    Try a nearby locality, another property type, or a larger radius in Settings.
                  </p>
                  <div className="emptyacts">
                    <button onClick={() => setSearchFilter('all')}>Show all leads</button>
                    <button onClick={() => openCollector('portals')}>Collect from sites</button>
                  </div>
                </>
              ) : leads.length ? (
                <>
                  {onlyComplete && !leads.some((l) => l.email && l.phone) ? (
                    <>
                      <h3>None of these {leads.length} agents has both an email and a phone yet</h3>
                      <p>
                        Most agents on Google Maps list a phone but no email. Search more areas to find ones that publish both,
                        <br />
                        or untick <b>Email + phone</b> to see agents with a phone only.
                      </p>
                    </>
                  ) : (
                    <>
                      <h3>Nothing matches those filters</h3>
                      <p>Loosen the filters above to see the rest.</p>
                    </>
                  )}
                </>
              ) : (
                <>
                  <h3>No leads yet</h3>
                  <p>
                    Enter a locality and how many leads you want, then press Find leads.
                    <br />
                    Results are ranked so the most contactable agents come first.
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {selected && (
          <Detail
            lead={selected}
            send={sendState.get(selected.id)}
            onClose={() => setSelectedId(null)}
            onStatus={(s) => setStatus(selected, s)}
            onNotes={async (notes) => patchLead(await api.leads.update(selected.id, { notes }))}
            onWhatsApp={() => openWhatsApp(selected)}
            onDelete={() => removeLead(selected)}
            onCopy={copy}
          />
        )}
      </section>

      <section className="logs">
        <div className="logshead">
          <strong>Activity</strong>
          <span className="count-note">{lines.length ? `${lines.length} events` : ''}</span>
          <span className="spacer" />
          <label className="toggle">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow
          </label>
          <button className="ghost sm" onClick={clear}>
            Clear
          </button>
          <button className="ghost sm" onClick={() => setLogHidden((h) => !h)}>
            {logHidden ? 'Show' : 'Hide'}
          </button>
        </div>
        <LogBody lines={lines} follow={follow} hidden={logHidden} />
      </section>

      {modal === 'settings' && <SettingsModal onClose={() => setModal(null)} onChanged={setSettings} />}
      {modal === 'registry' && (
        <RegistryModal
          stats={rera}
          onClose={() => setModal(null)}
          onChanged={reloadAll}
          onOpenBrowser={() => {
            setModal(null);
            openCollector('rera');
          }}
        />
      )}
      {modal === 'add' && <AddLeadModal onClose={() => setModal(null)} onAdded={reloadAll} />}
      {modal === 'email' && (
        <EmailModal
          targets={shown}
          sendable={sendable}
          outreach={outreach}
          sender={sender}
          settings={settings}
          totals={totals}
          onSettings={setSettings}
          onChanged={loadCampaigns}
          onClose={() => setModal(null)}
        />
      )}
    </>
  );
}

function EmailBadge({ status }: { status: Lead['emailStatus'] }) {
  if (status === 'verified') return <span className="badge verified" title="The email's domain accepts mail">verified</span>;
  if (status === 'invalid') return <span className="badge dnc" title="The domain doesn't exist or accepts no mail: this would bounce">won't deliver</span>;
  if (status === 'unknown') return <span className="badge generic" title="Couldn't check (offline?). Will retry.">unchecked</span>;
  return <span className="badge none">checking…</span>;
}

/** One agent per row: just the name, phone number and email. Everything else is in the detail panel. */
function LeadRow({ lead: l, selected, onClick }: { lead: Lead; selected: boolean; onClick: () => void }) {
  return (
    <tr className={cx(selected && 'selected', l.status !== 'New' && 'contacted')} onClick={onClick}>
      <td>
        <div className="cellflex">
          <span className="t cname">{l.businessName}</span>
          {l.reraNumber && (
            <span className="badge rera" title={`RERA ${l.reraNumber}`}>
              RERA
            </span>
          )}
        </div>
        {l.name && <div className="csub">{l.name}</div>}
      </td>
      <td className="mono">
        {l.phone ? (
          <div className="cellflex">
            <span className="t">{l.phone}</span>
            {l.phoneType === 'mobile' && <span className="badge mobile">mob</span>}
          </div>
        ) : (
          <span className="muted">{l.phoneRaw || '—'}</span>
        )}
      </td>
      <td>
        {l.email ? (
          <div className="cellflex">
            <span className="t mono">{l.email}</span>
            <EmailBadge status={l.emailStatus} />
          </div>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  );
}

function Detail({
  lead: l,
  send,
  onClose,
  onStatus,
  onNotes,
  onWhatsApp,
  onDelete,
  onCopy,
}: {
  lead: Lead;
  send?: { status: CampaignLeadStatus; error: string | null };
  onClose: () => void;
  onStatus: (s: LeadStatus) => void;
  onNotes: (notes: string | null) => void;
  onWhatsApp: () => void;
  onDelete: () => void;
  onCopy: (v: string) => void;
}) {
  const [notes, setNotes] = useState(l.notes ?? '');
  useEffect(() => setNotes(l.notes ?? ''), [l.id, l.notes]);

  const row = (label: string, value: ReactNode) =>
    value === null || value === undefined || value === '' ? null : (
      <>
        <dt>{label}</dt>
        <dd>{value}</dd>
      </>
    );
  const link = (url: string, text?: string) => (
    <a href={url} onClick={(e) => (e.preventDefault(), api.shell.openExternal(url))}>
      {text ?? url}
    </a>
  );

  return (
    <aside className="detail">
      <div className="detailhead">
        <h2>{l.businessName}</h2>
        <button className="ghost sm" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="acts">
        {l.phone && l.status !== 'Do Not Contact' && (
          <button className="sm" onClick={onWhatsApp}>
            WhatsApp
          </button>
        )}
        {l.website && (
          <button className="sm" onClick={() => api.shell.openExternal(l.website!)}>
            Website
          </button>
        )}
        {l.mapsUrl && (
          <button className="sm" onClick={() => api.shell.openExternal(l.mapsUrl!)}>
            Maps
          </button>
        )}
        <span className="spacer" />
        <button className="ghost sm" onClick={onDelete}>
          Delete
        </button>
      </div>
      <dl>
        <dt>Status</dt>
        <dd>
          <select value={l.status} onChange={(e) => onStatus(e.target.value as LeadStatus)}>
            {LEAD_STATUSES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </dd>
        {row('Lead score', scoreOf(l))}
        {row('Contact person', l.name)}
        {row(
          'Phone',
          l.phone ? (
            <>
              <span className="mono copyable" title="Click to copy" onClick={() => onCopy(l.phone!)}>
                {l.phone}
              </span>
              <div className="muted">
                ✓ valid Indian {l.phoneType === 'unknown' ? '' : `${l.phoneType} `}number — format checked, not called
              </div>
            </>
          ) : (
            l.phoneRaw && <span className="muted">{l.phoneRaw} (couldn't validate)</span>
          ),
        )}
        {row(
          'Email',
          l.allEmails.length ? (
            l.allEmails.map((e) => (
              <div key={e} className="mono copyable" title="Click to copy" onClick={() => onCopy(e)}>
                {e}
              </div>
            ))
          ) : (
            l.email
          ),
        )}
        {row(
          'Email check',
          l.email &&
            (l.emailStatus === 'verified' ? (
              <span className="ok">✓ verified — the domain accepts mail (mailbox itself not tested)</span>
            ) : l.emailStatus === 'invalid' ? (
              <span className="err">✗ won't deliver — the domain doesn't exist or accepts no mail</span>
            ) : l.emailStatus === 'unknown' ? (
              <span className="muted">couldn't check (offline?) — will retry</span>
            ) : (
              <span className="muted">checking…</span>
            )),
        )}
        {row('Email send', send && <span className={send.status === 'failed' ? 'err' : send.status === 'sent' ? 'ok' : ''}>{send.status}{send.error ? ` — ${send.error}` : ''}</span>)}
        {row('Website', l.website && link(l.website))}
        {row('Address', l.address)}
        {row('Rating', l.rating != null && `★ ${l.rating.toFixed(1)} (${l.ratingCount ?? 0} reviews)`)}
        {row('RERA number', l.reraNumber && <span className="mono">{l.reraNumber}</span>)}
        {row('Property types', l.propertyTypes.join(', '))}
        {row('Sources', l.sources.map((s) => SOURCE_LABEL[s] ?? s).join(', '))}
        {row('Searched for', l.locationQuery)}
        {row('Found', new Date(l.createdAt).toLocaleString())}
        {row('Last contacted', l.lastContactedAt && new Date(l.lastContactedAt).toLocaleString())}
        <dt>Notes</dt>
        <dd>
          <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== (l.notes ?? '') && onNotes(notes.trim() || null)} placeholder="Add a note…" />
        </dd>
      </dl>
    </aside>
  );
}

function LogBody({ lines, follow, hidden }: { lines: ReturnType<typeof useFeedback>['lines']; follow: boolean; hidden: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (follow) ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [lines, follow, hidden]);
  const cls = { ok: 'ev-done', error: 'ev-error', warn: 'ev-fallback', system: 'ev-system', info: '' } as const;
  return (
    <div className="logbody" ref={ref} hidden={hidden}>
      {lines.map((l) => (
        <div key={l.id} className={cx('logline', cls[l.tone])}>
          <span className="ts">{l.ts}</span>
          {l.msg}
        </div>
      ))}
    </div>
  );
}
