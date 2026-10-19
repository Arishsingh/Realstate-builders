/**
 * Email verification without sending anything: checks that the address is well formed and that its
 * domain publishes mail servers (MX records) in DNS. That catches dead domains, typos and made-up
 * addresses. It cannot prove the individual mailbox exists — providers like Gmail don't reveal that,
 * and probing mail servers from a home connection is unreliable and looks like spam.
 */
import { promises as dns } from 'node:dns';
import type { EmailStatus } from '../../src/shared/types';

// '%' is legal in theory but on web pages it's always a URL-encoding leftover ("%20info@…").
const SYNTAX = /^[a-z0-9.!#$&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;

export interface Resolver {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
}

/** DNS answers that mean "this domain has no mail servers", as opposed to "couldn't check". */
const NO_MAIL = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN', 'ENONAME']);

export async function checkEmailDomain(email: string, resolver: Resolver = dns): Promise<EmailStatus> {
  if (!SYNTAX.test(email) || email.includes('..')) return 'invalid';
  const domain = email.split('@')[1].toLowerCase();
  try {
    const mx = await resolver.resolveMx(domain);
    // A "null MX" (exchange ".") is a domain explicitly saying it accepts no mail.
    return mx.some((r) => r.exchange && r.exchange !== '.') ? 'verified' : 'invalid';
  } catch (err) {
    return NO_MAIL.has(String((err as { code?: string }).code)) ? 'invalid' : 'unknown';
  }
}

/** Checks many addresses, a few at a time, asking DNS once per domain. */
export async function checkEmails(emails: string[], resolver: Resolver = dns, concurrency = 8): Promise<Map<string, EmailStatus>> {
  const byDomain = new Map<string, Promise<EmailStatus>>();
  const out = new Map<string, EmailStatus>();
  let next = 0;
  const worker = async () => {
    while (next < emails.length) {
      const email = emails[next++].toLowerCase();
      if (!SYNTAX.test(email)) {
        out.set(email, 'invalid');
        continue;
      }
      const domain = email.split('@')[1];
      if (!byDomain.has(domain)) byDomain.set(domain, checkEmailDomain(`x@${domain}`, resolver));
      out.set(email, await byDomain.get(domain)!);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out;
}
