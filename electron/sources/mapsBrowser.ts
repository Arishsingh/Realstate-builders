/**
 * Free Google Maps source: no API key and no card. A hidden browser window opens Google Maps,
 * scrolls the results list and reads each listing (name, phone, website, address, rating),
 * the way cosci-leads' "Browser only" source does.
 *
 * Google's terms don't allow automated reading of Maps, and it may slow down or ask for a
 * "not a robot" check when it notices. So this goes at a human pace, one listing at a time.
 * If Google shows a check, the window is shown so the user can solve it themselves, and the
 * search carries on afterwards. It never tries to get around the check.
 */
import { BrowserWindow, type WebContents } from 'electron';
import { AppFailure } from '../errors';
import { buildQueries } from './googlePlaces';
import { placeKey, toRawLead, type MapsPlaceRecord } from './mapsBrowserParse';
import type { LeadSource, RawLead, SourceContext } from './types';

const PARTITION = 'persist:gmaps';
const CHECK_WAIT_MS = 3 * 60_000;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });
/** 0.8–1.8 s: roughly how fast a person clicks through listings. */
const humanPause = (signal: AbortSignal) => sleep(800 + Math.random() * 1000, signal);

const js = <T>(wc: WebContents, code: string) => wc.executeJavaScript(code, true).catch(() => null) as Promise<T | null>;

async function waitFor<T>(wc: WebContents, code: string, timeoutMs: number, signal: AbortSignal): Promise<T | null> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await js<T>(wc, code);
    if (v) return v;
    await sleep(250, signal);
  }
  return null;
}

const IS_CHECK = `location.hostname.includes('consent.') ? 'consent' : (location.pathname.startsWith('/sorry') || /unusual traffic|not a robot/i.test(document.body?.innerText?.slice(0, 3000) || '')) ? 'captcha' : ''`;
const ACCEPT_CONSENT = `(() => { const b = [...document.querySelectorAll('button, input[type=submit]')].find(x => /accept all|reject all|i agree/i.test(x.innerText || x.value || '')); if (b) { b.click(); return true; } return false; })()`;
const FEED_HREFS = `(() => { const f = document.querySelector('div[role="feed"]'); return f ? [...f.querySelectorAll('a[href*="/maps/place/"]')].map(a => a.href) : null; })()`;
const SCROLL_FEED = `(() => { const f = document.querySelector('div[role="feed"]'); if (f) f.scrollTo(0, f.scrollHeight); return /reached the end of the list/i.test(f?.innerText?.slice(-400) || ''); })()`;
const READ_PLACE = `(() => {
  const q = (s) => document.querySelector(s);
  const attr = (s, a) => q(s)?.getAttribute(a) || '';
  return {
    title: q('h1')?.innerText?.trim() || '',
    phoneItemId: attr('button[data-item-id^="phone:tel:"]', 'data-item-id'),
    phoneLabel: attr('button[data-item-id^="phone"]', 'aria-label'),
    address: attr('button[data-item-id="address"]', 'aria-label'),
    website: attr('a[data-item-id="authority"]', 'href'),
    category: q('button[jsaction*="category"]')?.innerText?.trim() || '',
    stars: attr('span[role="img"][aria-label*="star"]', 'aria-label'),
    url: location.href,
  };
})()`;

/** Handles Google's cookie page and "unusual traffic" check. Shows the window for a check and waits for the user. */
async function clearChecks(win: BrowserWindow, ctx: SourceContext) {
  const wc = win.webContents;
  for (let i = 0; i < 3; i++) {
    const kind = await js<string>(wc, IS_CHECK);
    if (!kind) return;
    if (kind === 'consent') {
      await js(wc, ACCEPT_CONSENT);
      await sleep(1500, ctx.signal);
      continue;
    }
    ctx.progress('Google is asking to confirm you are not a robot. Solve it in the window that just opened; the search continues after.');
    win.show();
    win.focus();
    const solved = await waitFor<boolean>(wc, `!(${IS_CHECK})`, CHECK_WAIT_MS, ctx.signal);
    win.hide();
    if (!solved) throw new AppFailure('NETWORK', 'Google kept asking for a "not a robot" check. Leads found so far are saved; try again later.');
  }
}

async function load(win: BrowserWindow, url: string, ctx: SourceContext) {
  // Maps is a single-page app: a load can "fail" with ERR_ABORTED while the page is fine.
  await win.webContents.loadURL(url).catch(() => undefined);
  await clearChecks(win, ctx);
}

/** Scrolls one search's results list and returns the place links in it. */
async function collectPlaces(win: BrowserWindow, query: string, want: number, ctx: SourceContext): Promise<string[]> {
  const wc = win.webContents;
  await load(win, `https://www.google.com/maps/search/${encodeURIComponent(query).replace(/%20/g, '+')}?hl=en`, ctx);
  // Wait until the list has links (an empty list renders first), or Maps jumped straight to one place.
  const first = await waitFor<string[] | 'place'>(
    wc,
    `((h) => (h && h.length ? h : null))(${FEED_HREFS}) || (location.pathname.includes('/maps/place/') && !document.querySelector('div[role="feed"]') && document.querySelector('h1') ? 'place' : null)`,
    15_000,
    ctx.signal,
  );
  if (!first) return [];
  if (first === 'place') return [String(await js<string>(wc, 'location.href'))]; // a single match opens directly

  const seen = new Set<string>(first);
  let stale = 0;
  while (seen.size < want && stale < 4) {
    ctx.signal.throwIfAborted();
    const before = seen.size;
    const ended = await js<boolean>(wc, SCROLL_FEED);
    for (let i = 0; i < 12 && seen.size === before; i++) {
      await sleep(250, ctx.signal);
      for (const h of (await js<string[]>(wc, FEED_HREFS)) ?? []) seen.add(h);
    }
    if (ended) break;
    stale = seen.size === before ? stale + 1 : 0;
  }
  return [...seen];
}

async function readPlace(win: BrowserWindow, href: string, ctx: SourceContext): Promise<MapsPlaceRecord | null> {
  const wc = win.webContents;
  await load(win, href.includes('hl=') ? href : `${href}${href.includes('?') ? '&' : '?'}hl=en`, ctx);
  if (!(await waitFor<boolean>(wc, `!!document.querySelector('h1')?.innerText`, 10_000, ctx.signal))) return null;
  // The phone and address rows render a moment after the heading, when the place has them.
  await waitFor<boolean>(wc, `!!document.querySelector('button[data-item-id="address"], button[data-item-id^="phone"]')`, 2_000, ctx.signal);
  return js<MapsPlaceRecord>(wc, READ_PLACE);
}

export const mapsBrowserSource: LeadSource = {
  id: 'maps_browser',
  name: 'Google Maps (free)',
  description: 'Reads Google Maps listings in a hidden window. No API key or card; slower, at a human pace.',

  unavailableReason() {
    return null;
  },

  async search(location, limit, filters, ctx) {
    const win = new BrowserWindow({
      show: false,
      width: 1280,
      height: 900,
      title: 'Google Maps — PropLeads',
      webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, images: false, backgroundThrottling: false },
    });
    win.webContents.setUserAgent(win.webContents.getUserAgent().replace(/\s(Electron|propleads)\/\S+/gi, ''));
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.on('close', (e) => {
      // Closing the check window shouldn't kill the search mid-way; just hide it.
      if (!ctx.signal.aborted) {
        e.preventDefault();
        win.hide();
      }
    });

    const out: RawLead[] = [];
    const opened = new Set<string>();
    try {
      for (const [qi, query] of buildQueries(location, filters.propertyTypes).entries()) {
        if (out.length >= limit) break;
        ctx.progress(`Google Maps: searching "${query}" (${qi + 1})…`);
        const hrefs = await collectPlaces(win, query, Math.ceil((limit - out.length) * 1.5) + 5, ctx);
        let fresh = 0;
        for (const href of hrefs) {
          if (out.length >= limit) break;
          const key = placeKey(href);
          if (opened.has(key) || ctx.isKnown({ externalId: `gmaps:${key}`, businessName: '' })) continue;
          opened.add(key);
          fresh++;
          await humanPause(ctx.signal);
          ctx.progress(`Google Maps: reading listing ${opened.size} (${out.length} of ${limit} found)…`);
          const rec = await readPlace(win, href, ctx).catch((err) => {
            if (err instanceof AppFailure || ctx.signal.aborted) throw err;
            return null; // one listing that won't load shouldn't stop the search
          });
          const lead = rec && toRawLead(rec, filters.propertyTypes);
          if (!lead || (!lead.phone && !lead.website) || ctx.isKnown(lead)) continue;
          out.push(lead);
          ctx.onLead?.(lead);
        }
        if (!fresh && qi === 0 && !hrefs.length) ctx.progress(`Google Maps: no results for "${query}".`);
        await humanPause(ctx.signal);
      }
    } finally {
      win.destroy();
    }
    return out;
  },
};
