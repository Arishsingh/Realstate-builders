/**
 * Mail merge for email and WhatsApp templates.
 * Placeholders: {{name}}, {{business}}, {{location}}, {{phone}}, {{website}}.
 * A fallback can follow a "|": {{name|there}} uses "there" when the lead has no contact name.
 */
import type { Lead } from './types';

export const PLACEHOLDERS = ['name', 'business', 'location', 'phone', 'website'] as const;

export const UNSUBSCRIBE_LINE =
  'If you would prefer not to hear from me again, just reply with "unsubscribe" and I will remove you from my list.';

const TOKEN = /\{\{\s*([a-zA-Z]+)\s*(?:\|([^}]*))?\}\}/g;

function values(lead: Pick<Lead, 'name' | 'businessName' | 'locationQuery' | 'phone' | 'website'>): Record<string, string> {
  return {
    // No contact person: greet the business instead of leaving "Hi ,".
    name: lead.name?.trim() || '',
    business: lead.businessName?.trim() || '',
    location: lead.locationQuery?.trim() || '',
    phone: lead.phone ?? '',
    website: lead.website ?? '',
  };
}

export function render(template: string, lead: Pick<Lead, 'name' | 'businessName' | 'locationQuery' | 'phone' | 'website'>): string {
  const v = values(lead);
  return template.replace(TOKEN, (_m, key: string, fallback?: string) => {
    const k = key.toLowerCase();
    const val = v[k] ?? '';
    if (val) return val;
    if (fallback !== undefined) return fallback.trim();
    if (k === 'name') return v.business || 'there';
    return '';
  });
}

/** Problems that should block sending: unknown placeholders and leftover [brackets] from the template. */
export function validateTemplate(subject: string, body: string): string[] {
  const problems: string[] = [];
  for (const text of [subject, body]) {
    for (const m of text.matchAll(TOKEN)) {
      if (!(PLACEHOLDERS as readonly string[]).includes(m[1].toLowerCase())) problems.push(`Unknown placeholder {{${m[1]}}}`);
    }
    const bracket = text.match(/\[[^\]\n]{2,60}\]/);
    if (bracket) problems.push(`Replace the placeholder text ${bracket[0]} before sending`);
  }
  if (!subject.trim()) problems.push('The subject is empty');
  if (!body.trim()) problems.push('The message is empty');
  return [...new Set(problems)];
}

/** Final plain-text email: the rendered body, the unsubscribe line and an optional sender footer. */
export function composeEmail(
  tpl: { subject: string; body: string },
  lead: Pick<Lead, 'name' | 'businessName' | 'locationQuery' | 'phone' | 'website'>,
  footer = '',
): { subject: string; text: string } {
  const subject = render(tpl.subject, lead).replace(/\s+/g, ' ').trim();
  const body = render(tpl.body, lead).trim();
  const text = [body, '', '--', UNSUBSCRIBE_LINE, footer.trim()].filter((l, i) => i < 4 || l).join('\n');
  return { subject, text };
}
