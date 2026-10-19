/**
 * Finds published email addresses on a lead's website: the homepage, /contact,
 * /contact-us and /about (plus a contact link found on the homepage).
 */
import { websiteDomain, isSharedHost } from '../normalize';
import { belongsToSite, extractEmails, findContactLinks, rankEmails } from './emails';
import type { PoliteFetcher } from './politeFetch';

const PATHS = ['/contact', '/contact-us', '/about', '/about-us'];

export async function findWebsiteEmails(website: string, fetcher: PoliteFetcher, signal: AbortSignal): Promise<string[]> {
  const domain = websiteDomain(website);
  // Social profiles and listing portals: their emails belong to the platform, not the agent.
  if (!domain || isSharedHost(domain)) return [];
  const start = /^https?:\/\//i.test(website) ? website : `https://${website}`;

  const emails = new Set<string>();
  const home = await fetcher.get(start, signal);
  // Site down, blocked by robots.txt or not HTML: don't keep knocking on sub-pages.
  if (!home) return [];
  const origin = new URL(home.finalUrl).origin;
  const pages = new Set(PATHS.map((p) => origin + p));
  const keep = (html: string) => extractEmails(html).filter((e) => belongsToSite(e, domain)).forEach((e) => emails.add(e));
  keep(home.html);
  findContactLinks(home.html, home.finalUrl).forEach((u) => pages.add(u));

  for (const url of pages) {
    // Two good addresses is plenty; stop early and spare the site some requests.
    if (emails.size >= 2) break; // only addresses that belong to the business are kept
    const page = await fetcher.get(url, signal);
    if (page) keep(page.html);
  }
  return rankEmails([...emails], domain).slice(0, 5);
}
