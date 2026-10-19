import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { composeEmail, validateTemplate } from '../shared/template';
import type { Campaign, EmailTemplate, Lead, SenderState, Settings } from '../shared/types';
import { Field, Modal } from './Modal';
import { useToast } from './Toast';

/** "Send" keeps adding to this one campaign, so counts and per-row send state stay in one place. */
export const OUTREACH = 'PropLeads outreach';

const VARS = ['name', 'business', 'location', 'phone', 'website'];
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/**
 * Email outreach: edit the template (autosaved), preview it for any lead in the table,
 * and send it to every new lead currently shown, one at a time through your SMTP account.
 */
export default function EmailModal({
  targets,
  sendable,
  outreach,
  sender,
  settings,
  totals,
  onSettings,
  onChanged,
  onClose,
}: {
  targets: Lead[];
  sendable: Lead[];
  outreach: Campaign | null;
  sender: SenderState | null;
  settings: Settings | null;
  totals: { sent: number; failed: number };
  onSettings: (s: Settings) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const toast = useToast();
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [templateId, setTemplateId] = useState<number | null>(null);
  const [draft, setDraft] = useState({ name: '', subject: '', body: '' });
  const [footer, setFooter] = useState(settings?.senderFooter ?? '');
  const [previewId, setPreviewId] = useState<number | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const subjectRef = useRef<HTMLInputElement>(null);
  const lastField = useRef<'subject' | 'body'>('body');

  const pick = (t: EmailTemplate) => {
    setTemplateId(t.id);
    setDraft({ name: t.name, subject: t.subject, body: t.body });
  };

  useEffect(() => {
    api.templates.list().then((ts) => {
      setTemplates(ts);
      const preferred = ts.find((t) => t.id === outreach?.templateId) ?? ts[0];
      if (preferred) pick(preferred);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = templates.find((t) => t.id === templateId) ?? null;
  const dirty = Boolean(active && (active.name !== draft.name || active.subject !== draft.subject || active.body !== draft.body));

  const saveTemplate = useCallback(async () => {
    if (!templateId) return;
    const t = await api.templates.save({ id: templateId, ...draft });
    setTemplates((ts) => ts.map((x) => (x.id === t.id ? t : x)));
  }, [templateId, draft]);

  // Autosave: there is no Save button for the message.
  useEffect(() => {
    if (!dirty) return;
    const timer = setTimeout(saveTemplate, 600);
    return () => clearTimeout(timer);
  }, [dirty, saveTemplate]);

  useEffect(() => {
    if (!settings || footer === settings.senderFooter) return;
    const timer = setTimeout(async () => {
      const res = await api.settings.update({ senderFooter: footer });
      if (res.ok) onSettings(res.data);
    }, 600);
    return () => clearTimeout(timer);
  }, [footer, settings, onSettings]);

  async function newTemplate() {
    if (dirty) await saveTemplate();
    const t = await api.templates.save({ name: `Template ${templates.length + 1}`, subject: 'Hello from {{location}}', body: 'Hi {{name}},\n\n\n\nBest regards,\n' });
    setTemplates((ts) => [...ts, t]);
    pick(t);
  }

  async function deleteTemplate() {
    if (!templateId || !confirm(`Delete the template "${draft.name}"?`)) return;
    await api.templates.remove(templateId);
    const rest = templates.filter((t) => t.id !== templateId);
    setTemplates(rest);
    if (rest[0]) pick(rest[0]);
    else {
      setTemplateId(null);
      setDraft({ name: '', subject: '', body: '' });
    }
  }

  function insertVar(key: string) {
    const token = `{{${key}}}`;
    const field = lastField.current;
    const el = field === 'subject' ? subjectRef.current : bodyRef.current;
    if (!el) return;
    const value = draft[field];
    const s = el.selectionStart ?? value.length;
    const e = el.selectionEnd ?? value.length;
    setDraft((d) => ({ ...d, [field]: value.slice(0, s) + token + value.slice(e) }));
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(s + token.length, s + token.length);
    });
  }

  const withEmail = targets.filter((l) => l.email);
  const previewLead = withEmail.find((l) => l.id === previewId) ?? withEmail[0] ?? null;
  const preview = previewLead && templateId ? composeEmail(draft, previewLead, footer) : null;
  const problems = templateId ? validateTemplate(draft.subject, draft.body) : [];
  const queued = outreach?.counts.queued ?? 0;
  const sending = Boolean(sender?.running);

  async function sendToMyself() {
    if (!templateId || !previewLead) return;
    await saveTemplate();
    const res = await api.templates.sendTest(templateId, previewLead.id);
    toast(res.ok ? res.data.message : res.error.message, res.ok ? 'ok' : 'error');
  }

  async function send() {
    if (!templateId) return toast('Create a template first.', 'error');
    if (problems.length) return toast(problems.join('. '), 'error');
    const msg = sendable.length
      ? `Email ${plural(sendable.length, 'lead')} using "${draft.name}"?${queued ? ` (${queued} already queued will go too.)` : ''}\n\nOne email every ${settings?.emailThrottleSeconds ?? 30}s, up to ${settings?.dailyEmailCap ?? '?'} a day.`
      : `Resume sending the ${plural(queued, 'queued email')}?`;
    if (!confirm(msg)) return;
    await saveTemplate();
    let c = outreach;
    if (!c) c = await api.campaigns.create(OUTREACH, templateId, sendable.map((l) => l.id));
    else {
      await api.campaigns.update(c.id, { templateId });
      if (sendable.length) await api.campaigns.addLeads(c.id, sendable.map((l) => l.id));
    }
    const res = await api.campaigns.start(c.id);
    if (!res.ok) toast(res.error.message, 'error');
    else toast(`Sending started: ${plural(sendable.length + queued, 'email')} queued.`, 'ok');
    onChanged();
  }

  async function stop() {
    if (sender?.campaignId) await api.campaigns.pause(sender.campaignId);
    toast('Sending paused.');
    onChanged();
  }

  return (
    <Modal
      title="Email outreach"
      wide
      hint={
        <>
          Sends to every lead <b>currently shown in the table</b> that has an email and is still <i>New</i>. Filter the table first to narrow it down. Do Not
          Contact leads are always skipped and every email ends with an unsubscribe line.
        </>
      }
      onClose={onClose}
      actions={
        <>
          <div className="counts">
            <span>
              new with email <b>{sendable.length}</b>
            </span>
            <span>
              queued <b>{queued}</b>
            </span>
            <span className="good">
              sent <b>{totals.sent}</b>
            </span>
            <span className="bad">
              failed <b>{totals.failed}</b>
            </span>
            {sender && (
              <span>
                today <b>{sender.sentToday}</b>/{sender.dailyCap}
              </span>
            )}
          </div>
          <button className="ghost" onClick={onClose}>
            Close
          </button>
          {sending ? (
            <button className="danger" onClick={stop}>
              Stop sending
            </button>
          ) : (
            <button className="primary" onClick={send} disabled={!templateId || (!sendable.length && !queued)}>
              {sendable.length ? `Send to ${plural(sendable.length, 'lead')}` : queued ? 'Resume sending' : 'Send'}
            </button>
          )}
        </>
      }
    >
      {sending && <p className="note">{sender?.message}</p>}
      {!sending && outreach?.status === 'paused' && outreach.statusNote && <p className="note warn">{outreach.statusNote}</p>}

      <div className="cols">
        <div>
          <Field label="Template">
            <div className="row">
              <select
                value={templateId ?? ''}
                onChange={async (e) => {
                  if (dirty) await saveTemplate();
                  const t = templates.find((x) => x.id === Number(e.target.value));
                  if (t) pick(t);
                }}
              >
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button className="sm" onClick={newTemplate}>
                New
              </button>
              <button className="ghost sm" onClick={deleteTemplate} disabled={!templateId}>
                Delete
              </button>
            </div>
          </Field>
          <Field label="Template name">
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} disabled={!templateId} />
          </Field>
          <Field label="Subject">
            <input
              ref={subjectRef}
              value={draft.subject}
              onFocus={() => (lastField.current = 'subject')}
              onChange={(e) => setDraft({ ...draft, subject: e.target.value })}
              placeholder="Buyer enquiries for your {{location}} listings"
              disabled={!templateId}
            />
          </Field>
          <Field label="Message">
            <textarea
              ref={bodyRef}
              rows={11}
              spellCheck
              value={draft.body}
              onFocus={() => (lastField.current = 'body')}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              disabled={!templateId}
            />
          </Field>
          <div className="varbar">
            {VARS.map((v) => (
              <button key={v} className="chipx" onClick={() => insertVar(v)} disabled={!templateId} title={`Insert {{${v}}}`}>
                {`{{${v}}}`}
              </button>
            ))}
          </div>
          <p className="note">
            <b>{'{{name}}'}</b> is the contact person when known, otherwise the business. Add a fallback with a bar: {'{{name|there}}'}.
          </p>
          <Field label="Footer (same for everyone: business name, address)">
            <textarea rows={2} value={footer} onChange={(e) => setFooter(e.target.value)} />
          </Field>
        </div>

        <div>
          <Field label="Preview for">
            <select value={previewLead?.id ?? ''} onChange={(e) => setPreviewId(Number(e.target.value))} disabled={!withEmail.length}>
              {withEmail.length === 0 && <option value="">no lead with an email in the table</option>}
              {withEmail.slice(0, 500).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.businessName} · {l.email}
                </option>
              ))}
            </select>
          </Field>
          <label>Preview</label>
          <div className="preview">
            <div className="ph">
              <span>To</span>
              <b>{previewLead?.email ?? '—'}</b>
              <span className="spacer" />
              <button className="ghost sm" onClick={sendToMyself} disabled={!preview}>
                Send this to myself
              </button>
            </div>
            {preview ? (
              <>
                <div className="ps">{preview.subject}</div>
                <div className="pb">
                  {preview.text.split(/\n{2,}/).map((p, i) => (
                    <p key={i}>{p}</p>
                  ))}
                </div>
              </>
            ) : (
              <div className="pb">
                <p className="empty-p">{templateId ? 'No lead with an email address in the table.' : 'Create a template to start.'}</p>
              </div>
            )}
          </div>
          {problems.length > 0 && <p className="note warn">{problems.join('. ')}.</p>}
        </div>
      </div>
    </Modal>
  );
}
