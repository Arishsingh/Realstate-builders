import { describe, expect, it } from 'vitest';
import { checkEmailDomain, checkEmails, type Resolver } from '../electron/enrich/verifyEmail';

const err = (code: string) => Object.assign(new Error(code), { code });
const fake = (table: Record<string, { exchange: string; priority: number }[] | string>): Resolver & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    async resolveMx(domain) {
      calls.push(domain);
      const v = table[domain];
      if (typeof v === 'string') throw err(v);
      if (!v) throw err('ENOTFOUND');
      return v;
    },
  };
};

describe('checkEmailDomain', () => {
  const r = fake({
    'frpl.in': [{ exchange: 'mx.zoho.in', priority: 10 }],
    'gmail.com': [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }],
    'nomail.in': [{ exchange: '.', priority: 0 }],
    'parked.in': 'ENODATA',
    'slow.in': 'ETIMEOUT',
  });

  it('verifies domains that publish mail servers', async () => {
    expect(await checkEmailDomain('enquiry@frpl.in', r)).toBe('verified');
    expect(await checkEmailDomain('lotekarrealtors@gmail.com', r)).toBe('verified');
  });

  it('rejects malformed addresses, missing domains and domains that refuse mail', async () => {
    expect(await checkEmailDomain('%20info@frpl.in', r)).toBe('invalid');
    expect(await checkEmailDomain('a..b@frpl.in', r)).toBe('invalid');
    expect(await checkEmailDomain('info@doesnotexist-xyz.in', r)).toBe('invalid');
    expect(await checkEmailDomain('info@parked.in', r)).toBe('invalid');
    expect(await checkEmailDomain('info@nomail.in', r)).toBe('invalid');
  });

  it('reports unknown (not invalid) when DNS could not answer', async () => {
    expect(await checkEmailDomain('info@slow.in', r)).toBe('unknown');
  });
});

describe('checkEmails', () => {
  it('looks each domain up once', async () => {
    const r = fake({ 'gmail.com': [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }] });
    const res = await checkEmails(['a@gmail.com', 'b@gmail.com', 'C@Gmail.com', 'bad@'], r);
    expect(Object.fromEntries(res)).toEqual({ 'a@gmail.com': 'verified', 'b@gmail.com': 'verified', 'c@gmail.com': 'verified', 'bad@': 'invalid' });
    expect(r.calls).toEqual(['gmail.com']);
  });
});
