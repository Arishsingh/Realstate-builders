import { useState } from 'react';
import { api } from '../api';
import { Field, Modal } from './Modal';
import { useToast } from './Toast';

/** Manual entry: only the email is required, and several can be pasted at once. */
export default function AddLeadModal({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ emails: '', businessName: '', name: '', phone: '', location: '' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const many = f.emails.split(/[\s,;]+/).filter(Boolean).length > 1;

  async function save() {
    const res = await api.leads.add(f);
    if (!res.ok) return toast(res.error.message, 'error');
    const { added, duplicates } = res.data;
    toast(`Added ${added} lead${added === 1 ? '' : 's'}${duplicates ? ` · ${duplicates} already in the list` : ''}`, 'ok');
    onAdded();
    onClose();
  }

  return (
    <Modal
      title="Add lead"
      hint="Paste several emails at once (one per line or comma separated) and each becomes its own lead. The other fields are then skipped, since they would only fit one of them."
      onClose={onClose}
      actions={
        <>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" onClick={save} disabled={!f.emails.trim()}>
            Add to list
          </button>
        </>
      }
    >
      <Field label="Email (required)">
        <textarea autoFocus rows={2} value={f.emails} onChange={set('emails')} placeholder="sales@agency.com" />
      </Field>
      <div className="grid2">
        <Field label="Business name">
          <input value={f.businessName} onChange={set('businessName')} disabled={many} placeholder="from the domain if blank" />
        </Field>
        <Field label="Contact person">
          <input value={f.name} onChange={set('name')} disabled={many} placeholder="Rahul Mehta" />
        </Field>
        <Field label="Phone">
          <input className="mono" value={f.phone} onChange={set('phone')} disabled={many} placeholder="98765 43210" />
        </Field>
        <Field label="Location">
          <input value={f.location} onChange={set('location')} disabled={many} placeholder="Baner, Pune" />
        </Field>
      </div>
    </Modal>
  );
}
