/**
 * Sites PropLeads doesn't read automatically (their terms forbid scraping, or they block bots).
 * These open the search in your browser; copy what you need into a CSV and use Leads → Import CSV.
 */

const q = encodeURIComponent;
const google = (query: string) => `https://www.google.com/search?q=${q(query)}`;

export interface PortalLink {
  name: string;
  url: string;
  note: string;
}

export function portalLinks(location: string): PortalLink[] {
  const loc = location.trim();
  const locality = loc.split(',')[0].trim();
  return [
    { name: 'Google Maps', url: `https://www.google.com/maps/search/${q(`real estate agents in ${loc}`)}`, note: 'Same data the Google source uses' },
    { name: 'Google Search', url: google(`real estate agents in ${loc}`), note: 'Agents with their own websites' },
    { name: 'Justdial', url: google(`site:justdial.com real estate agents ${loc}`), note: 'Opens Justdial listings via Google' },
    { name: '99acres', url: google(`site:99acres.com real estate agents ${loc}`), note: 'Agent profiles via Google' },
    { name: 'Magicbricks', url: google(`site:magicbricks.com real estate agents ${loc}`), note: 'Agent profiles via Google' },
    { name: 'Housing.com', url: google(`site:housing.com real estate agents ${loc}`), note: 'Agent profiles via Google' },
    { name: 'LinkedIn', url: `https://www.linkedin.com/search/results/companies/?keywords=${q(`real estate ${locality}`)}`, note: 'Company pages (sign-in needed)' },
    { name: 'Builders & Projects', url: 'https://www.buildersandprojects.com/all-builders/', note: 'Builder directory' },
    { name: 'reale.in', url: `https://reale.in/search?q=${q(locality)}`, note: 'RERA projects (also a built-in source)' },
  ];
}

/** State RERA portals: agent/project registries to export or copy from, then import as CSV. */
export const RERA_PORTALS: PortalLink[] = [
  { name: 'MahaRERA (Maharashtra)', url: 'https://www.maharera.maharashtra.gov.in/agents-search-result', note: 'Registered agents search' },
  { name: 'GujRERA (Gujarat)', url: 'https://gujrera.gujarat.gov.in/', note: 'Agents & projects' },
  { name: 'UP RERA (Uttar Pradesh)', url: 'https://www.up-rera.in/', note: 'Agents & projects' },
  { name: 'K-RERA (Kerala)', url: 'https://rera.kerala.gov.in/', note: 'Projects also via reale.in' },
  { name: 'Haryana RERA', url: 'https://haryanarera.gov.in/', note: 'Projects also via reale.in' },
  { name: 'Rajasthan RERA', url: 'https://rera.rajasthan.gov.in/', note: 'Projects also via reale.in' },
];
