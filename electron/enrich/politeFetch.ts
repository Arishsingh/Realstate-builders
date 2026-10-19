/**
 * Polite HTTP fetching for website enrichment:
 *  - identifies itself with a clear User-Agent
 *  - respects robots.txt (cached per host)
 *  - at most one request per second per domain (configurable, never faster)
 *  - per-request timeout and a response size cap
 */
import { robotsAllows } from './emails';

export const USER_AGENT = 'PropLeadsBot/1.0 (+contact-finder; respects robots.txt)';
const MAX_BYTES = 1_500_000;

export interface PoliteFetcherOptions {
  minDelayMs: number;
  timeoutMs: number;
}

export class PoliteFetcher {
  private queue = new Map<string, Promise<void>>();
  private lastDone = new Map<string, number>();
  private robots = new Map<string, Promise<string | null>>();

  constructor(private opts: PoliteFetcherOptions) {}

  /**
   * Requests to one host run one at a time, and each starts at least minDelayMs after the
   * previous one finished, so the site never sees more than one request per interval.
   */
  private async throttled<T>(host: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const prev = this.queue.get(host) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    this.queue.set(host, prev.then(() => mine));
    await prev;
    try {
      const wait = (this.lastDone.get(host) ?? 0) + this.opts.minDelayMs - Date.now();
      if (wait > 0) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, wait);
          signal.addEventListener('abort', () => {
            clearTimeout(t);
            reject(signal.reason);
          });
        });
      }
      return await fn();
    } finally {
      this.lastDone.set(host, Date.now());
      release();
    }
  }

  private raw(url: URL, signal: AbortSignal) {
    return this.throttled(url.hostname, signal, () => this.request(url, signal));
  }

  private async request(url: URL, signal: AbortSignal): Promise<{ status: number; body: string; finalUrl: string }> {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' },
      redirect: 'follow',
      signal: AbortSignal.any([signal, AbortSignal.timeout(this.opts.timeoutMs)]),
    });
    const type = res.headers.get('content-type') ?? '';
    if (!res.ok || (type && !/text|html|xml/i.test(type))) {
      await res.body?.cancel().catch(() => {});
      return { status: res.status, body: '', finalUrl: res.url };
    }
    // Read at most MAX_BYTES so a huge page can't stall enrichment.
    const reader = res.body?.getReader();
    if (!reader) return { status: res.status, body: '', finalUrl: res.url };
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
    await reader.cancel().catch(() => {});
    return { status: res.status, body: Buffer.concat(chunks).toString('utf8'), finalUrl: res.url };
  }

  private robotsFor(origin: URL, signal: AbortSignal): Promise<string | null> {
    const key = origin.origin;
    if (!this.robots.has(key)) {
      this.robots.set(
        key,
        this.raw(new URL('/robots.txt', origin), signal)
          .then((r) => (r && r.status >= 200 && r.status < 300 ? r.body : null))
          .catch(() => null),
      );
    }
    return this.robots.get(key)!;
  }

  /** Fetch a page as text. Returns null when robots.txt disallows it or the request fails. */
  async get(urlStr: string, signal: AbortSignal): Promise<{ html: string; finalUrl: string } | null> {
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      return null;
    }
    if (!/^https?:$/.test(url.protocol)) return null;
    const robots = await this.robotsFor(url, signal);
    if (robots && !robotsAllows(robots, USER_AGENT, url.pathname + url.search)) return null;
    try {
      const r = await this.raw(url, signal);
      return r && r.body ? { html: r.body, finalUrl: r.finalUrl } : null;
    } catch (err) {
      if (signal.aborted) throw err;
      return null;
    }
  }
}
