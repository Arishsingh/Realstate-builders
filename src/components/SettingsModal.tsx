import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Result, Settings, SettingsUpdate } from '../shared/types';
import { Field, Modal } from './Modal';
import { useToast } from './Toast';

const Saved = ({ on }: { on: boolean }) => <span className={on ? 'ok' : 'muted'}>{on ? '● saved (encrypted)' : '○ not set'}</span>;

/** Keys, SMTP account, sending pace and search options. Secrets never come back to this window. */
export default function SettingsModal({ onClose, onChanged }: { onClose: () => void; onChanged: (s: Settings) => void }) {
  const toast = useToast();
  const [s, setS] = useState<Settings | null>(null);
  const [placesKey, setPlacesKey] = useState('');
  const [smtpPass, setSmtpPass] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    api.settings.get().then(setS);
  }, []);

  if (!s) return null;

  async function save(patch: SettingsUpdate, okMsg = 'Settings saved') {
    const res = await api.settings.update(patch);
    if (!res.ok) {
      toast(res.error.message, 'error');
      return false;
    }
    setS(res.data);
    onChanged(res.data);
    toast(okMsg, 'ok');
    return true;
  }

  async function run(label: string, fn: () => Promise<Result<{ message: string }>>) {
    setBusy(label);
    const res = await fn();
    setBusy(null);
    toast(res.ok ? res.data.message : res.error.message, res.ok ? 'ok' : 'error');
  }

  async function saveAll() {
    const ok = await save({
      smtp: s!.smtp,
      ...(smtpPass ? { smtpPassword: smtpPass } : {}),
      ...(placesKey.trim() ? { placesApiKey: placesKey } : {}),
      emailThrottleSeconds: s!.emailThrottleSeconds,
      dailyEmailCap: s!.dailyEmailCap,
      perDomainDelayMs: s!.perDomainDelayMs,
      requestTimeoutMs: s!.requestTimeoutMs,
      enrichEmailsByDefault: s!.enrichEmailsByDefault,
      defaultRadiusKm: s!.defaultRadiusKm,
      maxPagesPerQuery: s!.maxPagesPerQuery,
      placesMode: s!.placesMode,
      lookupBuilderContacts: s!.lookupBuilderContacts,
    });
    if (ok) {
      setSmtpPass('');
      setPlacesKey('');
    }
  }

  const smtp = s.smtp;
  const setSmtp = (patch: Partial<Settings['smtp']>) => setS({ ...s, smtp: { ...smtp, ...patch } });
  const num = (v: string) => Number(v) || 0;

  return (
    <Modal
      title="Settings"
      wide
      hint={
        <>
          The Places API key and SMTP password are encrypted with your system keychain. They are never sent to this window — only whether one is set.
        </>
      }
      onClose={onClose}
      actions={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={saveAll}>
            Save
          </button>
        </>
      }
    >
      {!s.secureStorageAvailable && <p className="note warn">Secure storage is unavailable on this system, so keys and passwords can't be saved.</p>}

      <div className="cols">
        <div>
          <div className="sub2">Google Places API</div>
          <Field label={<>API key · <Saved on={s.hasPlacesApiKey} /></>}>
            <div className="row">
              <input type="password" value={placesKey} onChange={(e) => setPlacesKey(e.target.value)} placeholder="paste to set or update" autoComplete="off" />
              <button className="sm" disabled={!s.hasPlacesApiKey || busy === 'places'} onClick={() => run('places', () => api.settings.testPlacesKey())}>
                Test
              </button>
              {s.hasPlacesApiKey && (
                <button className="ghost sm" onClick={() => save({ placesApiKey: '' }, 'API key removed')}>
                  Remove
                </button>
              )}
            </div>
          </Field>
          <p className="note">
            Needs “Places API (New)” on a Google Cloud project with billing.{' '}
            <button className="link" onClick={() => api.shell.openExternal('https://console.cloud.google.com/apis/library/places.googleapis.com')}>
              Open Cloud Console
            </button>
          </p>
          <div className="grid2">
            <Field label="Radius (km)">
              <input className="mono" type="number" min={1} max={50} value={s.defaultRadiusKm} onChange={(e) => setS({ ...s, defaultRadiusKm: num(e.target.value) })} />
            </Field>
            <Field label="Pages per query">
              <input className="mono" type="number" min={1} max={3} value={s.maxPagesPerQuery} onChange={(e) => setS({ ...s, maxPagesPerQuery: num(e.target.value) })} />
            </Field>
          </div>
          <Field label="Fetch mode (affects cost)">
            <select value={s.placesMode} onChange={(e) => setS({ ...s, placesMode: e.target.value as Settings['placesMode'] })}>
              <option value="combined">Text Search only</option>
              <option value="details">Text Search + Place Details</option>
            </select>
          </Field>
          <label className="check">
            <input type="checkbox" checked={s.lookupBuilderContacts} onChange={(e) => setS({ ...s, lookupBuilderContacts: e.target.checked })} />
            <span>
              Look up phone and website for RERA builders on Google
              <small>One Places request per builder found.</small>
            </span>
          </label>

          <div className="sub2">Website email crawl</div>
          <div className="grid2">
            <Field label="Delay per site (ms)">
              <input className="mono" type="number" min={1000} value={s.perDomainDelayMs} onChange={(e) => setS({ ...s, perDomainDelayMs: num(e.target.value) })} />
            </Field>
            <Field label="Timeout (ms)">
              <input className="mono" type="number" min={2000} value={s.requestTimeoutMs} onChange={(e) => setS({ ...s, requestTimeoutMs: num(e.target.value) })} />
            </Field>
          </div>
          <label className="check">
            <input type="checkbox" checked={s.enrichEmailsByDefault} onChange={(e) => setS({ ...s, enrichEmailsByDefault: e.target.checked })} />
            <span>
              Find emails on lead websites
              <small>Homepage, /contact and /about. 1 request/sec per site, respects robots.txt.</small>
            </span>
          </label>
        </div>

        <div>
          <div className="sub2">Email account (SMTP)</div>
          <p className="note">Gmail: smtp.gmail.com, port 465, SSL, and an App Password (not your login password).</p>
          <div className="grid2">
            <Field label="Username">
              <input value={smtp.user} onChange={(e) => setSmtp({ user: e.target.value.trim() })} placeholder="you@gmail.com" autoComplete="off" />
            </Field>
            <Field label={<>Password · <Saved on={s.hasSmtpPassword} /></>}>
              <input type="password" value={smtpPass} onChange={(e) => setSmtpPass(e.target.value)} placeholder="paste to set or update" autoComplete="new-password" />
            </Field>
            <Field label="SMTP host">
              <input value={smtp.host} onChange={(e) => setSmtp({ host: e.target.value.trim() })} placeholder="smtp.gmail.com" />
            </Field>
            <div className="grid2">
              <Field label="Port">
                <input className="mono" type="number" value={smtp.port} onChange={(e) => setSmtp({ port: num(e.target.value) })} />
              </Field>
              <Field label="Security">
                <select value={smtp.secure ? 'ssl' : 'starttls'} onChange={(e) => setSmtp({ secure: e.target.value === 'ssl' })}>
                  <option value="ssl">SSL</option>
                  <option value="starttls">STARTTLS</option>
                </select>
              </Field>
            </div>
            <Field label="From name">
              <input value={smtp.fromName} onChange={(e) => setSmtp({ fromName: e.target.value })} placeholder="Your Name" />
            </Field>
            <Field label="From email">
              <input value={smtp.fromEmail} onChange={(e) => setSmtp({ fromEmail: e.target.value.trim() })} placeholder="you@gmail.com" />
            </Field>
          </div>
          <p className="note">
            <button className="link" disabled={busy === 'smtp'} onClick={() => run('smtp', () => api.settings.testSmtp())}>
              {busy === 'smtp' ? 'Testing…' : 'Test login'}
            </button>{' '}
            uses the saved settings, so press Save first.
          </p>

          <div className="sub2">Sending pace</div>
          <div className="grid2">
            <Field label="Seconds between emails">
              <input className="mono" type="number" min={5} value={s.emailThrottleSeconds} onChange={(e) => setS({ ...s, emailThrottleSeconds: num(e.target.value) })} />
            </Field>
            <Field label="Max emails per day">
              <input className="mono" type="number" min={1} value={s.dailyEmailCap} onChange={(e) => setS({ ...s, dailyEmailCap: num(e.target.value) })} />
            </Field>
          </div>
          <p className="note">Gmail allows roughly 500 recipients a day; under 100 is safer.</p>
        </div>
      </div>
    </Modal>
  );
}
