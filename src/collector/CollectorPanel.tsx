import { useEffect, useState } from 'react';
import { api } from '../api';
import { cx } from '../components/Modal';
import { useToast } from '../components/Toast';
import { portalLinks, RERA_PORTALS } from '../shared/portalLinks';
import type { CollectorState, ContactCandidate, ReraPageImport } from '../shared/types';

type Row = ContactCandidate & { key: number; keep: boolean };
let nextKey = 1;

/**
 * Right-hand panel of the Collector window. The website is on the left; this panel turns
 * what the user selects or pastes there into leads, and imports RERA result tables.
 */
export default function CollectorPanel() {
  const toast = useToast();
  const [s, setS] = useState<CollectorState | null>(null);
  const [url, setUrl] = useState('');
  const [location, setLocation] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [paste, setPaste] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [lastRera, setLastRera] = useState<ReraPageImport | null>(null);

  useEffect(() => {
    api.collector.state().then((st) => {
      setS(st);
      setLocation(st.location);
    });
    return api.collector.onState((st) => {
      setS(st);
      setUrl(st.url);
    });
  }, []);

  useEffect(() => {
    if (s?.url) setUrl(s.url);
  }, [s?.url]);

  if (!s) return null;
  const rera = s.mode === 'rera';

  function addCandidates(list: ContactCandidate[], from: string) {
    if (!list.length) {
      toast(from === 'selection' ? 'No phone, email or website in the selected text. Select the whole listing, including the number.' : 'No phone numbers or emails found in that text.', 'error');
      return;
    }
    setRows((rs) => [...list.map((c) => ({ ...c, phoneRaw: c.phoneRaw ?? c.phone, key: nextKey++, keep: true })), ...rs]);
    toast(`Found ${list.length} contact${list.length === 1 ? '' : 's'} — check them below, then Save.`, 'ok');
  }

  async function fromSelection() {
    setBusy('sel');
    addCandidates(await api.collector.readSelection(), 'selection');
    setBusy(null);
  }

  async function fromPaste() {
    addCandidates(await api.collector.parse(paste), 'paste');
    setPaste('');
  }

  async function save() {
    const keep = rows.filter((r) => r.keep);
    setBusy('save');
    const res = await api.collector.save(keep);
    setBusy(null);
    if (!res.ok) return toast(res.error.message, 'error');
    const { added, duplicates } = res.data;
    toast(`Saved ${added} lead${added === 1 ? '' : 's'}${duplicates ? ` · ${duplicates} already in your list` : ''}`, 'ok');
    setRows((rs) => rs.filter((r) => !r.keep));
  }

  async function importPage() {
    setBusy('rera');
    const res = await api.collector.importReraPage();
    setBusy(null);
    if (!res.ok) return toast(res.error.message, 'error');
    setLastRera(res.data);
    toast(`Imported ${res.data.agents} agents · ${res.data.addedLeads} new leads`, 'ok');
  }

  const setRow = (key: number, patch: Partial<Row>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const sites = rera ? RERA_PORTALS : location.trim() ? portalLinks(location) : [];
  const keepCount = rows.filter((r) => r.keep).length;

  return (
    <div className="cpanel">
      <div className="chead">
        <div className="ctabs">
          <button className={cx(!rera && 'on')} onClick={() => api.collector.setMode('portals', location)}>
            Portals
          </button>
          <button className={cx(rera && 'on')} onClick={() => api.collector.setMode('rera', location)}>
            RERA
          </button>
        </div>
        <div className="row cnav">
          <button className="ghost sm" disabled={!s.canGoBack} onClick={() => api.collector.nav('back')} title="Back">
            ←
          </button>
          <button className="ghost sm" disabled={!s.canGoForward} onClick={() => api.collector.nav('forward')} title="Forward">
            →
          </button>
          <button className="ghost sm" onClick={() => api.collector.nav('reload')} title="Reload">
            {s.loading ? '…' : '↻'}
          </button>
          <input
            className="mono"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && api.collector.navigate(/^https?:\/\//.test(url) ? url : `https://${url}`)}
            spellCheck={false}
          />
        </div>
      </div>

      <div className="cbody">
        {!rera && (
          <>
            <label>Locality</label>
            <div className="row">
              <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Wakad, Pune" onKeyDown={(e) => e.key === 'Enter' && api.collector.setMode('portals', location)} />
              <button className="sm" onClick={() => api.collector.setMode('portals', location)} disabled={!location.trim()}>
                Go
              </button>
            </div>
          </>
        )}

        {sites.length > 0 && (
          <div className="districts">
            {sites.map((p) => (
              <button key={p.name} className={cx('chipx', s.url.includes(new URL(p.url).hostname.replace(/^www\./, '')) && 'on')} onClick={() => api.collector.navigate(p.url)} title={p.note}>
                {p.name.replace(/ \(.*\)$/, '')}
              </button>
            ))}
          </div>
        )}

        {rera ? (
          <>
            <ol className="steps">
              <li>Pick your state above and open its <b>registered agents</b> search.</li>
              <li>Search a district (e.g. Pune) and solve the CAPTCHA yourself.</li>
              <li>When the results list shows, press <b>Import this page</b>. Go to the next page and press it again.</li>
            </ol>
            <button className="primary big" onClick={importPage} disabled={busy === 'rera'}>
              {busy === 'rera' ? 'Reading the page…' : 'Import this page'}
            </button>
            {lastRera && (
              <div className="rows">
                <div className="r">
                  <span className="n">Agents on this page</span>
                  <span className="m">{lastRera.agents}</span>
                </div>
                <div className="r">
                  <span className="n">New leads added</span>
                  <span className="m">{lastRera.addedLeads}</span>
                </div>
                <div className="r">
                  <span className="n">Already in your list</span>
                  <span className="m">{lastRera.duplicates}</span>
                </div>
                <div className="r">
                  <span className="n">Existing leads tagged RERA</span>
                  <span className="m">{lastRera.tagged}</span>
                </div>
              </div>
            )}
            <p className="note">Results shown as cards instead of a table? Select them and use Add from selection below.</p>
          </>
        ) : (
          <ol className="steps">
            <li>Pick a site above. It opens already searched for agents in your locality.</li>
            <li>
              <b>Highlight</b> a listing on the left — its name and phone number — then press <b>Add from selection</b>. Or copy many listings and paste them below.
            </li>
            <li>Check the contacts, then <b>Save</b>. They go straight into your leads table.</li>
          </ol>
        )}

        <button className={cx(rera ? '' : 'primary', 'big')} onClick={fromSelection} disabled={busy === 'sel'}>
          {busy === 'sel' ? 'Reading…' : 'Add from selection'}
        </button>

        <details className="pastebox">
          <summary>Paste a list</summary>
          <textarea rows={5} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste copied listings here — names, phone numbers, emails…" />
          <div className="row end">
            <button className="sm" onClick={fromPaste} disabled={!paste.trim()}>
              Find contacts
            </button>
          </div>
        </details>

        {rows.length > 0 && (
          <>
            <div className="sub2">
              To save <span className="muted">({keepCount} of {rows.length} ticked)</span>
            </div>
            {rows.map((r) => (
              <div key={r.key} className={cx('cand', !r.keep && 'off')}>
                <div className="row">
                  <input type="checkbox" className="tick" checked={r.keep} onChange={(e) => setRow(r.key, { keep: e.target.checked })} title="Include" />
                  <input className="cname" value={r.businessName} onChange={(e) => setRow(r.key, { businessName: e.target.value })} placeholder="Business name" />
                  <button className="ghost sm" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} title="Remove">
                    ×
                  </button>
                </div>
                <div className="grid2">
                  <input className="mono" value={r.phoneRaw ?? ''} onChange={(e) => setRow(r.key, { phoneRaw: e.target.value })} placeholder="Phone" />
                  <input className="mono" value={r.email ?? ''} onChange={(e) => setRow(r.key, { email: e.target.value })} placeholder="Email" />
                  <input value={r.name ?? ''} onChange={(e) => setRow(r.key, { name: e.target.value })} placeholder="Contact person" />
                  <input value={r.website ?? ''} onChange={(e) => setRow(r.key, { website: e.target.value })} placeholder="Website" />
                </div>
                <input value={r.address ?? ''} onChange={(e) => setRow(r.key, { address: e.target.value })} placeholder="Address" />
                {(r.phoneType === 'mobile' || r.reraNumber) && (
                  <div className="tags">
                    {r.phoneType === 'mobile' && <span className="badge mobile">mobile</span>}
                    {r.reraNumber && <span className="badge rera">RERA {r.reraNumber}</span>}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="cfoot">
        <span className="count-note">{s.added ? `${s.added} lead${s.added === 1 ? '' : 's'} saved this session` : 'Nothing saved yet'}</span>
        <span className="spacer" />
        <button className="primary" onClick={save} disabled={!keepCount || busy === 'save'}>
          {busy === 'save' ? 'Saving…' : `Save ${keepCount || ''} lead${keepCount === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  );
}
