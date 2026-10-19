import { describe, expect, it } from 'vitest';
import { placeKey, toRawLead, type MapsPlaceRecord } from '../electron/sources/mapsBrowserParse';

const URL = 'https://www.google.com/maps/place/Shree+Plots/data=!4m7!3m6!1s0x3bc2b9:0x4f2a1c!8m2!3d18.55!4d73.78!16s?entry=ttu&hl=en';
const rec = (p: Partial<MapsPlaceRecord>): MapsPlaceRecord => ({
  title: 'Shree Ganesh Plots & Land',
  phoneItemId: 'phone:tel:09822012345',
  phoneLabel: 'Phone: 098220 12345 ',
  address: 'Address: Office 12, Baner Rd, Pune, Maharashtra 411045 ',
  website: 'https://shreeganeshplots.in/',
  category: 'Real estate agency',
  stars: '4.3 stars 1,128 Reviews',
  url: URL,
  ...p,
});

describe('Google Maps browser parsing', () => {
  it('keys places by their stable Maps place id', () => {
    expect(placeKey(URL)).toBe('0x3bc2b9:0x4f2a1c');
    expect(placeKey('https://www.google.com/maps/place/X/data=!1s0x3BC2B9:0x4F2A1C!8m2?q=other')).toBe('0x3bc2b9:0x4f2a1c');
  });

  it('reads name, phone, website, address and rating from a listing', () => {
    expect(toRawLead(rec({}), ['Plots'])).toEqual({
      externalId: 'gmaps:0x3bc2b9:0x4f2a1c',
      businessName: 'Shree Ganesh Plots & Land',
      phone: '09822012345',
      website: 'https://shreeganeshplots.in/',
      address: 'Office 12, Baner Rd, Pune, Maharashtra 411045',
      rating: 4.3,
      ratingCount: 1128,
      mapsUrl: URL.split('?')[0],
      notes: 'Real estate agency',
      propertyTypes: ['Plots'],
    });
  });

  it('falls back to the phone label and drops Google redirect links as websites', () => {
    const l = toRawLead(rec({ phoneItemId: '', website: 'https://www.google.com/url?q=x' }), []);
    expect(l?.phone).toBe('098220 12345');
    expect(l?.website).toBeNull();
  });

  it('skips non-agent places and empty panels', () => {
    expect(toRawLead(rec({ category: 'Bank' }), [])).toBeNull();
    expect(toRawLead(rec({ title: '' }), [])).toBeNull();
    expect(toRawLead(rec({ category: 'Real estate developer' }), [])).not.toBeNull();
  });
});
