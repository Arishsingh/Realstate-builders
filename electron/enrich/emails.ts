/**
 * Pure email-extraction helpers (no network), unit-tested in test/emails.test.ts.
 */

const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const MAILTO_RE = /mailto:([^"'?\s>]+)/gi;

const JUNK_DOMAINS = [
  'example.com',
  'example.org',
  'domain.com',
  'email.com',
  'yourdomain.com',
  'yoursite.com',
  'sentry.io',
  'sentry-next.wixpress.com',
  'wixpress.com',
  'wix.com',
  'sentry.wixpress.com',
  'godaddy.com',
  'squarespace.com',
  'w3.org',
  'schema.org',
  'googleapis.com',
  'cloudflare.com',
];
const JUNK_LOCAL = /^(noreply|no-reply|donotreply|do-not-reply|your\.?name|name|user|username|email|test|abc|xyz)$/i;
const FILE_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|ico|css|js|mjs|json|woff2?|ttf|eot|mp4|webm|pdf)$/i;

function decodeEntities(s: string) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&commat;|&#64;/gi, '@')
    .replace(/&period;/gi, '.')
    .replace(/&amp;/g, '&');
}

/**
 * Repairs common page artefacts: "team@www.site.com" (a typo for team@site.com) and
 * URL-encoded leftovers such as "%20info@site.com" from mailto: links.
 */
export function tidyEmail(email: string): string {
  return email
    .trim()
    .toLowerCase()
    .replace(/^(%[0-9a-f]{2})+/i, '')
    .replace('@www.', '@');
}

export function isJunkEmail(email: string): boolean {
  const e = email.toLowerCase();
  const [local, domain] = e.split('@');
  if (!local || !domain) return true;
  if (FILE_EXT.test(e)) return true; // e.g. logo@2x.png
  if (/@\d+x\./.test(e)) return true;
  if (JUNK_DOMAINS.some((d) => domain === d || domain.endsWith('.' + d))) return true;
  if (JUNK_LOCAL.test(local)) return true;
  if (/^[0-9a-f]{16,}$/.test(local)) return true; // hashed ids (Sentry DSNs etc.)
  if (local.length > 64 || domain.length > 253 || !domain.includes('.')) return true;
  return false;
}

/** All plausible emails in an HTML page: plain text, mailto: links and simple [at]/(dot) obfuscation. */
export function extractEmails(html: string): string[] {
  const text = decodeEntities(html);
  const found = new Set<string>();
  for (const m of text.matchAll(MAILTO_RE)) {
    try {
      found.add(decodeURIComponent(m[1]).trim().toLowerCase());
    } catch {
      found.add(m[1].trim().toLowerCase());
    }
  }
  const deobfuscated = text
    .replace(/\s*[[(]\s*at\s*[\])]\s*/gi, '@')
    .replace(/\s*[[(]\s*dot\s*[\])]\s*/gi, '.');
  for (const m of deobfuscated.matchAll(EMAIL_RE)) found.add(m[0].toLowerCase().replace(/^[._-]+|[._-]+$/g, ''));
  return [...new Set([...found].map(tidyEmail))].filter((e) => /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e) && !isJunkEmail(e));
}

/** Personal mailbox providers: agents often publish a Gmail or Rediffmail address instead of one on their own domain. */
const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|rocketmail|hotmail|outlook|live|msn|rediffmail|rediff|icloud|me|aol|protonmail|proton|zoho|zohomail|gmx|yandex)\.[a-z.]{2,6}$/;

/**
 * Whether an address found on a site plausibly belongs to that business: on the site's own
 * domain, or a personal mailbox. Anything else on the page is someone else's — the theme's
 * author, a font foundry, a listing platform — and must not be emailed as if it were the agent.
 */
export function belongsToSite(email: string, siteDomain: string | null): boolean {
  const domain = email.toLowerCase().split('@')[1] ?? '';
  if (FREE_MAIL.test(domain)) return true;
  if (!siteDomain) return false;
  return domain === siteDomain || domain.endsWith('.' + siteDomain) || siteDomain.endsWith('.' + domain);
}

/**
 * Pick the best address for outreach: prefer one on the business's own domain,
 * then personal-looking addresses over role ones like info@.
 */
export function rankEmails(emails: string[], siteDomain: string | null): string[] {
  const score = (e: string) => {
    const [local, domain] = e.split('@');
    let s = 0;
    if (siteDomain && (domain === siteDomain || domain.endsWith('.' + siteDomain) || siteDomain.endsWith('.' + domain))) s += 10;
    if (/^(info|contact|sales|enquiry|enquiries|hello|office|admin|support)$/.test(local)) s -= 1;
    if (/^(careers|jobs|hr|privacy|abuse|webmaster|postmaster)$/.test(local)) s -= 5;
    return s;
  };
  return [...new Set(emails)].sort((a, b) => score(b) - score(a));
}

/** Links on the page that look like a contact/about page on the same site. */
export function findContactLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  const base = new URL(baseUrl);
  for (const m of html.matchAll(/<a\s[^>]*href\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    const label = m[2].replace(/<[^>]+>/g, ' ');
    if (!/contact|reach|about|get.in.touch/i.test(href + ' ' + label)) continue;
    try {
      const u = new URL(href, base);
      if (u.hostname === base.hostname && /^https?:$/.test(u.protocol)) out.add(u.href);
    } catch {
      /* ignore */
    }
  }
  return [...out].slice(0, 3);
}

/** Minimal robots.txt evaluation: the most specific matching group, longest matching rule wins. */
export function robotsAllows(robotsTxt: string, userAgent: string, path: string): boolean {
  const ua = userAgent.toLowerCase();
  type Group = { agents: string[]; rules: { allow: boolean; path: string }[] };
  const groups: Group[] = [];
  let cur: Group | null = null;
  let lastWasAgent = false;
  for (const rawLine of robotsTxt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'user-agent') {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === 'allow' || key === 'disallow') && cur) {
      lastWasAgent = false;
      if (value) cur.rules.push({ allow: key === 'allow', path: value });
    } else {
      lastWasAgent = false;
    }
  }
  const token = ua.split('/')[0];
  const group = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a))) ?? groups.find((g) => g.agents.includes('*'));
  if (!group) return true;
  const matches = (rule: string) => {
    const re = new RegExp('^' + rule.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    return re.test(path);
  };
  let best: { allow: boolean; len: number } | null = null;
  for (const r of group.rules) {
    if (matches(r.path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow))) best = { allow: r.allow, len: r.path.length };
  }
  return best ? best.allow : true;
}
