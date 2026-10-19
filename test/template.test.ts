import { describe, expect, it } from 'vitest';
import { composeEmail, render, UNSUBSCRIBE_LINE, validateTemplate } from '../electron/outreach/template';
import { leadsToCsv } from '../electron/export';
import type { Lead } from '../src/shared/types';

const lead = { name: null, businessName: 'Sharma Realty', locationQuery: 'Baner, Pune', phone: '+919823012345', website: null };

describe('render', () => {
  it('fills placeholders and falls back to the business name', () => {
    expect(render('Hi {{name}}, about {{business}} in {{location}}', lead)).toBe('Hi Sharma Realty, about Sharma Realty in Baner, Pune');
    expect(render('Hi {{ name | there }}', lead)).toBe('Hi there');
    expect(render('Hi {{name}}', { ...lead, name: 'Ravi' })).toBe('Hi Ravi');
  });
});

describe('validateTemplate', () => {
  it('blocks unknown placeholders and leftover brackets', () => {
    expect(validateTemplate('Hi', 'Dear {{firstName}}, [Your Name]')).toEqual([
      'Unknown placeholder {{firstName}}',
      'Replace the placeholder text [Your Name] before sending',
    ]);
    expect(validateTemplate('Hello {{name}}', 'Body')).toEqual([]);
  });
});

describe('composeEmail', () => {
  it('always appends the unsubscribe line', () => {
    const { subject, text } = composeEmail({ subject: 'Hi {{business}}', body: 'Hello' }, lead, 'Acme, Pune');
    expect(subject).toBe('Hi Sharma Realty');
    expect(text).toBe(`Hello\n\n--\n${UNSUBSCRIBE_LINE}\nAcme, Pune`);
  });
});

describe('leadsToCsv', () => {
  it('quotes fields and neutralises formulas', () => {
    const l = {
      id: 1, placeId: null, name: '=HYPERLINK("x")', businessName: 'A, B "Realty"', phone: '+919823012345', phoneRaw: null, phoneType: 'mobile',
      email: null, allEmails: [], website: null, domain: null, address: null, rating: 4.5, ratingCount: 10, mapsUrl: null, source: 'google_places',
      sources: ['google_places'], locationQuery: 'Baner', propertyTypes: [], reraNumber: null, status: 'New', notes: null, searchId: 1,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '', lastContactedAt: null,
    emailStatus: null,
    emailCheckedAt: null,
    } as Lead;
    const row = leadsToCsv([l]).split('\r\n')[1];
    expect(row.startsWith(`"'=HYPERLINK(""x"")","A, B ""Realty""",+919823012345,mobile`)).toBe(true);
    expect(row).toContain('https://wa.me/919823012345');
  });
});
