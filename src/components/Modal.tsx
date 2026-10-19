import { useEffect, type ReactNode } from 'react';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** cosci-leads style dialog card: title, content, actions row. Esc or a click outside closes it. */
export function Modal({
  title,
  hint,
  wide,
  onClose,
  actions,
  children,
}: {
  title: string;
  hint?: ReactNode;
  wide?: boolean;
  onClose: () => void;
  actions?: ReactNode;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modalcard', wide && 'wide')} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {hint && <p className="hint">{hint}</p>}
        {children}
        <div className="modalactions">
          {actions ?? (
            <button className="ghost" onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** A labelled control. Labels use the uppercase modal label style from cosci-leads. */
export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div>
      <label>{label}</label>
      {children}
    </div>
  );
}
