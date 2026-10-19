import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from 'react';

type Tone = 'info' | 'ok' | 'error' | 'warn' | 'system';

export interface LogLine {
  id: number;
  ts: string;
  msg: string;
  tone: Tone;
}

interface Feedback {
  toast: (text: string, tone?: Tone) => void;
  log: (text: string, tone?: Tone) => void;
  lines: LogLine[];
  clear: () => void;
}

const MAX_LINES = 400;
const Ctx = createContext<Feedback>({ toast: () => {}, log: () => {}, lines: [], clear: () => {} });

/** One toast at a time at the bottom, and every message also lands in the Log panel. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [current, setCurrent] = useState<{ text: string; tone: Tone } | null>(null);
  const [lines, setLines] = useState<LogLine[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const nextId = useRef(0);

  const log = useCallback((msg: string, tone: Tone = 'info') => {
    const ts = new Date().toLocaleTimeString([], { hour12: false });
    setLines((xs) => {
      if (xs[xs.length - 1]?.msg === msg) return xs; // progress events repeat; keep the log readable
      return [...xs.slice(-(MAX_LINES - 1)), { id: nextId.current++, ts, msg, tone }];
    });
  }, []);

  const toast = useCallback(
    (text: string, tone: Tone = 'info') => {
      log(text, tone);
      setCurrent({ text, tone });
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCurrent(null), tone === 'error' ? 7000 : 3500);
    },
    [log],
  );

  const clear = useCallback(() => setLines([]), []);

  return (
    <Ctx.Provider value={{ toast, log, lines, clear }}>
      {children}
      <div className={`toast ${current?.tone === 'error' ? 'err' : current?.tone === 'ok' ? 'ok' : ''}`} hidden={!current} aria-live="polite">
        {current?.text}
      </div>
    </Ctx.Provider>
  );
}

export const useFeedback = () => useContext(Ctx);
export const useToast = () => useContext(Ctx).toast;
