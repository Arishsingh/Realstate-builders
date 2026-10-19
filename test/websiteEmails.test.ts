import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PoliteFetcher, USER_AGENT } from '../electron/enrich/politeFetch';
import { findWebsiteEmails } from '../electron/enrich/websiteEmails';

// A fake agent website: homepage links to a contact page, robots.txt blocks /about.
const requests: { path: string; ua: string; at: number }[] = [];
const PAGES: Record<string, string> = {
  '/robots.txt': 'User-agent: *\nDisallow: /about\n',
  '/': '<html><a href="/reach-us">Reach us</a><img src="logo@2x.png"></html>',
  '/reach-us': '<p>Call or write: <a href="mailto:ravi@gmail.com">Ravi</a></p>',
  '/contact': '<p>sales [at] gmail.com</p>',
  '/about': '<p>secret@gmail.com</p>',
};
let server: http.Server;
let base = '';

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requests.push({ path: req.url!, ua: String(req.headers['user-agent']), at: Date.now() });
    const body = PAGES[req.url!];
    res.writeHead(body ? 200 : 404, { 'content-type': req.url === '/robots.txt' ? 'text/plain' : 'text/html' });
    res.end(body ?? 'not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('findWebsiteEmails', () => {
  it('reads homepage + contact pages, respects robots.txt and rate limits', async () => {
    const fetcher = new PoliteFetcher({ minDelayMs: 200, timeoutMs: 5000 });
    const emails = await findWebsiteEmails(base, fetcher, new AbortController().signal);
    expect(emails.sort()).toEqual(['ravi@gmail.com', 'sales@gmail.com']);
    expect(requests.some((r) => r.path === '/about')).toBe(false);
    expect(requests.every((r) => r.ua === USER_AGENT)).toBe(true);
    for (let i = 1; i < requests.length; i++) expect(requests[i].at - requests[i - 1].at).toBeGreaterThanOrEqual(190);
  });

  it('skips social profiles', async () => {
    const fetcher = new PoliteFetcher({ minDelayMs: 1000, timeoutMs: 5000 });
    expect(await findWebsiteEmails('https://www.facebook.com/agent', fetcher, new AbortController().signal)).toEqual([]);
  });
});
