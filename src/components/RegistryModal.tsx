import { useState } from 'react';
import { api } from '../api';
import { RERA_PORTALS } from '../shared/portalLinks';
import type { ReraStats } from '../shared/types';
import { Modal } from './Modal';
import { useToast } from './Toast';

/** The RERA agent registry behind the topbar pill: stats, import and the state portals to export from. */
export default function RegistryModal({
  stats,
  onClose,
  onChanged,
  onOpenBrowser,
}: {
  stats: ReraStats | null;
  onClose: () => void;
  onChanged: () => void;
  onOpenBrowser: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function importCsv() {
    setBusy(true);
    const res = await api.rera.importCsv();
    setBusy(false);
    if (!res.ok) toast(res.error.message, 'error');
    else if (res.data) toast(`Imported ${res.data.imported} agents (${res.data.skipped} skipped). Tagged ${res.data.tagged} leads.`, 'ok');
    onChanged();
  }

  async function clear() {
    if (!confirm('Remove all imported RERA agents? Existing lead tags are kept.')) return;
    await api.rera.clear();
    onChanged();
  }

  return (
    <Modal
      title="RERA registry"
      hint="A list of state-registered agents. Importing it tags matching leads as RERA registered, and lets the RERA source find agents by location without going online."
      onClose={onClose}
      actions={
        <>
          {Boolean(stats?.agents) && (
            <button className="ghost" onClick={clear}>
              Clear registry
            </button>
          )}
          <span className="spacer" />
          <button className="ghost" onClick={onClose}>
            Close
          </button>
          <button onClick={importCsv} disabled={busy}>
            {busy ? 'Importing…' : 'Import CSV'}
          </button>
          <button className="primary" onClick={onOpenBrowser}>
            Open RERA browser
          </button>
        </>
      }
    >
      <p className="note warn">
        Most state portals sit behind CAPTCHAs, and that gate is respected. Use <b>Open RERA browser</b>: search the portal inside PropLeads, solve the
        CAPTCHA yourself, then import each results page with one click. A CSV with a registration-number column works too.
      </p>

      <div className="rows">
        <div className="r">
          <span className="n">Agents imported</span>
          <span className="m">{stats?.agents.toLocaleString() ?? '—'}</span>
        </div>
        <div className="r">
          <span className="n">Leads tagged RERA</span>
          <span className="m">{stats?.taggedLeads.toLocaleString() ?? '—'}</span>
        </div>
        <div className="r">
          <span className="n">Last import</span>
          <span className="m">{stats?.lastImport ? new Date(stats.lastImport).toLocaleDateString() : 'never'}</span>
        </div>
      </div>

      <label>State portals</label>
      <div className="linkgrid">
        {RERA_PORTALS.map((p) => (
          <button key={p.name} onClick={() => api.shell.openExternal(p.url)} title={p.url}>
            {p.name}
            <small>{p.note}</small>
          </button>
        ))}
      </div>
    </Modal>
  );
}
