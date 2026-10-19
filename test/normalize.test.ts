import { describe, expect, it } from 'vitest';
import { dedupeDomain, Deduper, normalizePhone, websiteDomain, whatsappUrl } from '../electron/normalize';

describe('normalizePhone', () => {
  it('formats Indian mobiles to E.164', () => {
    expect(normalizePhone('098230 12345')).toEqual({ e164: '+919823012345', type: 'mobile' });
    expect(normalizePhone('+91 98230-12345')?.e164).toBe('+919823012345');
  });
  it('recognises landlines', () => {
    expect(normalizePhone('020 2567 1234')).toEqual({ e164: '+912025671234', type: 'landline' });
  });
  it('rejects junk', () => {
    expect(normalizePhone('12345')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
});

describe('domains', () => {
  it('extracts the host without www', () => {
    expect(websiteDomain('https://www.SharmaRealty.in/contact')).toBe('sharmarealty.in');
    expect(websiteDomain('sharmarealty.in')).toBe('sharmarealty.in');
  });
  it('ignores shared hosts for de-duplication', () => {
    expect(dedupeDomain('https://www.facebook.com/someagent')).toBeNull();
    expect(dedupeDomain('https://abc.business.site')).toBeNull();
    expect(dedupeDomain('https://sharmarealty.in')).toBe('sharmarealty.in');
  });
});

describe('Deduper', () => {
  it('matches on phone, then email, then domain', () => {
    const d = new Deduper();
    expect(d.add({ phone: '+919823012345', email: 'a@x.in', domain: 'x.in' })).toBe(true);
    expect(d.add({ phone: '+919823012345' })).toBe(false);
    expect(d.add({ email: 'A@X.IN' })).toBe(false);
    expect(d.add({ domain: 'x.in' })).toBe(false);
    expect(d.add({ phone: '+919800000000', domain: 'y.in' })).toBe(true);
  });
});

describe('whatsappUrl', () => {
  it('builds a wa.me link with an encoded message', () => {
    expect(whatsappUrl('+919823012345', 'Hi Ravi & team')).toBe('https://wa.me/919823012345?text=Hi%20Ravi%20%26%20team');
    expect(whatsappUrl(null)).toBeNull();
  });
});
