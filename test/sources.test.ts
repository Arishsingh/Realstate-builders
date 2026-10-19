import { describe, expect, it } from 'vitest';
import { detectLeadColumns, parseLeadCsv } from '../electron/leadCsv';
import { groupByPromoter, isOrganisation, locationParts, promoterNotes, type RealeProject } from '../electron/sources/realeData';

const proj = (p: Partial<RealeProject>): RealeProject => ({
  state_code: 'RJ', reg_no: 'RAJ/P/1', name: 'X', promoter_name: null, project_type: 'residential', status: 'registered', district: 'Jaipur', locality: null, ...p,
});

describe('reale.in helpers', () => {
  it('keeps organisations only (reale.in terms forbid contacting individuals)', () => {
    expect(isOrganisation('Shree Aangan Developers LLP')).toBe(true);
    expect(isOrganisation('M/s Gupta & Sons')).toBe(true);
    expect(isOrganisation('Ramesh Kumar Sharma')).toBe(false);
    expect(isOrganisation(null)).toBe(false);
  });

  it('groups projects by promoter, filters by type and status, most active first', () => {
    const groups = groupByPromoter(
      [
        proj({ reg_no: 'A1', promoter_name: 'Alpha Builders', project_type: 'plotted', locality: 'Chaksu' }),
        proj({ reg_no: 'A2', promoter_name: 'ALPHA builders ', project_type: 'residential', locality: 'Sanganer' }),
        proj({ reg_no: 'B1', promoter_name: 'Beta Realty Pvt Ltd', project_type: 'commercial' }),
        proj({ reg_no: 'C1', promoter_name: 'Gamma Infra', status: 'revoked' }),
        proj({ reg_no: 'D1', promoter_name: 'Dinesh Kumar' }),
      ],
      ['Plots', 'Flats'],
    );
    expect(groups.map((g) => g.name)).toEqual(['Alpha Builders']);
    expect(groups[0].projects).toHaveLength(2);
    expect(groups[0].localities).toEqual(['Chaksu', 'Sanganer']);
    expect(groups[0].propertyTypes).toContain('Plots');
    expect(promoterNotes(groups[0])).toMatch(/^Builder\/promoter with 2 RERA projects: X \(A1\); X \(A2\)\. Data: reale\.in$/);
  });

  it('splits locations most specific first', () => {
    expect(locationParts('Malviya Nagar, Jaipur')).toEqual(['Malviya Nagar', 'Jaipur']);
  });
});

describe('CSV lead import', () => {
  it('detects common column names', () => {
    expect(detectLeadColumns(['Company Name', 'Contact Person', 'Mobile No', 'E-mail', 'Website', 'City'])).toMatchObject({
      businessName: 'Company Name', name: 'Contact Person', phone: 'Mobile No', email: 'E-mail', website: 'Website', city: 'City',
    });
  });

  it('normalizes rows and skips ones without contact details', () => {
    const csv = '﻿Firm,Name,Phone,Email,City\nSai Estates,Anil,"98230 12345, 020 2567 1234",anil@sai.test,Pune\nNo Contact Realty,,,,Pune\nSolo Name Only,,,bad-email,Pune\n';
    const { leads, skipped } = parseLeadCsv(csv);
    expect(skipped).toBe(2);
    expect(leads).toHaveLength(1);
    expect(leads[0]).toMatchObject({ businessName: 'Sai Estates', name: 'Anil', phone: '+919823012345', phoneType: 'mobile', email: 'anil@sai.test', address: 'Pune' });
  });

  it('explains a file without usable columns', () => {
    expect(() => parseLeadCsv('foo,bar\n1,2\n')).toThrow(/name\/business column/);
  });
});
