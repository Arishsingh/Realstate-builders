import { describe, expect, it } from 'vitest';
import { parseContacts, reraTablesToAgents } from '../electron/collect/extract';

describe('parseContacts', () => {
  it('reads one selected listing', () => {
    const [c] = parseContacts(`Shree Ganesh Plots & Land Developers
4.3 ★ 128 Ratings
Verified
Office 12, Baner Road, Near Balewadi Phata, Pune
Call 098220 12345
Contact: Rahul Patil
www.shreeganeshplots.in`);
    expect(c).toMatchObject({
      businessName: 'Shree Ganesh Plots & Land Developers',
      name: 'Rahul Patil',
      phone: '+919822012345',
      phoneType: 'mobile',
      website: 'https://www.shreeganeshplots.in',
      address: 'Office 12, Baner Road, Near Balewadi Phata, Pune',
    });
  });

  it('splits a pasted list into one lead per business, without blank lines between them', () => {
    const list = parseContacts(`1. Sai Properties
Wakad, Pune
+91 98765 43210
2. Om Realty Consultants
4.8 (52)
Hinjewadi Phase 1, Pune
info@omrealty.co.in
020 2567 8901
3. Kumar Estate Agency
Aundh, Pune
9123456780`);
    expect(list.map((c) => c.businessName)).toEqual(['Sai Properties', 'Om Realty Consultants', 'Kumar Estate Agency']);
    expect(list[1].email).toBe('info@omrealty.co.in');
    expect(list[1].phone).toBe('+912025678901');
    expect(list[1].phoneType).toBe('landline');
    expect(list[2].phone).toBe('+919123456780');
  });

  it('separates businesses split by blank lines and skips ones with no contact', () => {
    const list = parseContacts(`Green Acres Land Brokers
Phone: 9822011111

Sponsored
Some Builder With No Number
Kothrud, Pune

Villa Homes Realty
sales@villahomes.in`);
    expect(list.map((c) => c.businessName)).toEqual(['Green Acres Land Brokers', 'Villa Homes Realty']);
  });

  it('picks up a RERA number and ignores portal links and email domains as websites', () => {
    const [c] = parseContacts(`Prime Plots Consultancy
MahaRERA Reg No: A51800034567
https://www.99acres.com/agent/prime-plots
contact@primeplots.com
9988776655`);
    expect(c.reraNumber).toBe('A51800034567');
    expect(c.website).toBeNull();
    expect(c.email).toBe('contact@primeplots.com');
  });

  it('returns nothing for text without contact details', () => {
    expect(parseContacts('Just some text about plots in Pune')).toEqual([]);
  });
});

describe('reraTablesToAgents', () => {
  it('uses a header row with a registration-number column', () => {
    const r = reraTablesToAgents([
      [['Search results']],
      [
        ['Sr. No.', 'Agent Name', 'Registration No.', 'District', 'Certificate'],
        ['1', 'RAHUL PATIL', 'A51800012345', 'Pune', 'View'],
        ['2', 'SAI PROPERTIES', 'A51800067890', 'Pune', 'View'],
      ],
    ]);
    expect(r?.agents.map((a) => [a.regNumber, a.name, a.district])).toEqual([
      ['A51800012345', 'RAHUL PATIL', 'Pune'],
      ['A51800067890', 'SAI PROPERTIES', 'Pune'],
    ]);
  });

  it('finds the registration column by its values when headers are missing', () => {
    const r = reraTablesToAgents([
      [
        ['1', 'Om Realty', 'A52100011111'],
        ['2', 'Kumar Estates', 'A52100022222'],
      ],
    ]);
    expect(r?.agents.map((a) => [a.regNumber, a.name])).toEqual([
      ['A52100011111', 'Om Realty'],
      ['A52100022222', 'Kumar Estates'],
    ]);
  });

  it('returns null when no table has registration numbers', () => {
    expect(reraTablesToAgents([[['Name', 'City'], ['Foo', 'Pune']]])).toBeNull();
  });
});
