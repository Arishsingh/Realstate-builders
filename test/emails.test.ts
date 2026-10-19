import { describe, expect, it } from 'vitest';
import { extractEmails, findContactLinks, isJunkEmail, rankEmails, robotsAllows } from '../electron/enrich/emails';

describe('extractEmails', () => {
  it('finds plain, mailto, entity-encoded and [at]-obfuscated addresses', () => {
    const html = `
      <p>Write to sales@sharmarealty.in</p>
      <a href="mailto:Ravi.Sharma@SharmaRealty.in?subject=Hi">Email</a>
      <span>info&#64;sharmarealty.in</span>
      <span>office [at] sharmarealty [dot] in</span>`;
    expect(extractEmails(html).sort()).toEqual(['info@sharmarealty.in', 'office@sharmarealty.in', 'ravi.sharma@sharmarealty.in', 'sales@sharmarealty.in']);
  });
  it('drops junk', () => {
    const html = `logo@2x.png you@example.com 8f14e45fceea167a5a36dedd4bea2543@sentry.wixpress.com noreply@site.in a@b.css`;
    expect(extractEmails(html)).toEqual([]);
  });
  it('flags image filenames and placeholder domains', () => {
    expect(isJunkEmail('banner@3x.jpg')).toBe(true);
    expect(isJunkEmail('user@domain.com')).toBe(true);
    expect(isJunkEmail('ravi@sharmarealty.in')).toBe(false);
  });
});

describe('rankEmails', () => {
  it('prefers the site domain and personal addresses', () => {
    expect(rankEmails(['someone@gmail.com', 'info@x.in', 'ravi@x.in', 'careers@x.in'], 'x.in')).toEqual(['ravi@x.in', 'info@x.in', 'careers@x.in', 'someone@gmail.com']);
  });
});

describe('findContactLinks', () => {
  it('returns same-site contact/about links only', () => {
    const html = `<a href="/contact-us">Contact</a><a href="https://other.com/contact">x</a><a href="/listings">Listings</a><a href="about.html">About us</a>`;
    expect(findContactLinks(html, 'https://x.in/')).toEqual(['https://x.in/contact-us', 'https://x.in/about.html']);
  });
});

describe('robotsAllows', () => {
  const robots = `
User-agent: *
Disallow: /private
Allow: /private/contact

User-agent: BadBot
Disallow: /`;
  it('applies the * group with longest-match rules', () => {
    expect(robotsAllows(robots, 'PropLeadsBot/1.0', '/contact')).toBe(true);
    expect(robotsAllows(robots, 'PropLeadsBot/1.0', '/private/x')).toBe(false);
    expect(robotsAllows(robots, 'PropLeadsBot/1.0', '/private/contact')).toBe(true);
  });
  it('uses a group naming our bot', () => {
    expect(robotsAllows('User-agent: PropLeadsBot\nDisallow: /\n', 'PropLeadsBot/1.0', '/')).toBe(false);
  });
  it('allows everything when robots.txt is empty', () => {
    expect(robotsAllows('', 'PropLeadsBot/1.0', '/contact')).toBe(true);
  });
});

import { belongsToSite } from '../electron/enrich/emails';

describe('belongsToSite', () => {
  it("keeps the business's own domain and personal mailboxes", () => {
    expect(belongsToSite('enquiry@frpl.in', 'frpl.in')).toBe(true);
    expect(belongsToSite('sales@mail.frpl.in', 'frpl.in')).toBe(true);
    expect(belongsToSite('dreamhouseproperties007@gmail.com', 'dreamhouse.in')).toBe(true);
    expect(belongsToSite('dhiraj_mandal@yahoo.com', null)).toBe(true);
    expect(belongsToSite('lotekar@rediffmail.com', 'lotekarrealtors.com')).toBe(true);
  });
  it('drops addresses of theme authors, font foundries and platforms', () => {
    expect(belongsToSite('luciano@latinotype.com', 'metropedia.in')).toBe(false);
    expect(belongsToSite('fk@adminblog.com', 'someproperties.com')).toBe(false);
    expect(belongsToSite('care@magicpin.in', 'abcproperties.in')).toBe(false);
  });
  it('repairs "@www." addresses', () => {
    expect(extractEmails('<a href="mailto:team@www.guptasen.com">x</a>')).toEqual(['team@guptasen.com']);
  });
});

describe('tidyEmail', () => {
  it('strips URL-encoded leftovers from mailto links', () => {
    expect(extractEmails('<a href="mailto:%20info@warehouseat.com">mail</a> %20sales@warehouseat.com')).toEqual(['info@warehouseat.com', 'sales@warehouseat.com']);
  });
});
