/**
 * Campaign sending over the user's own SMTP account (nodemailer).
 * One email at a time, a configurable pause between emails (default 30 s) and a daily cap.
 * Leads marked "Do Not Contact" (or whose address is suppressed) are skipped right before sending.
 */
import nodemailer from 'nodemailer';
import type { Lead, SenderState } from '../../src/shared/types';
import * as db from '../db';
import { AppFailure } from '../errors';
import { getSecret, getSettings } from '../settings';
import { composeEmail, validateTemplate } from './template';

type Listener = (s: SenderState) => void;

let listener: Listener = () => {};
let loop: Promise<void> | null = null;
let wakeUp: (() => void) | null = null;
let state: SenderState = { running: false, campaignId: null, sentToday: 0, dailyCap: 0, nextSendAt: null, message: 'Idle' };

export function onSenderState(cb: Listener) {
  listener = cb;
}

function setState(patch: Partial<SenderState>) {
  const s = getSettings();
  state = { ...state, ...patch, sentToday: db.sentToday(), dailyCap: s.dailyEmailCap };
  listener(state);
}

export function senderState(): SenderState {
  setState({});
  return state;
}

function transport() {
  const s = getSettings();
  const pass = getSecret('smtpPassword');
  if (!s.smtp.host || !s.smtp.user || !pass || !s.smtp.fromEmail) {
    throw new AppFailure('SMTP_NOT_CONFIGURED', 'Set up your SMTP account (host, user, password and from address) in Settings first.');
  }
  return nodemailer.createTransport({
    host: s.smtp.host,
    port: s.smtp.port,
    secure: s.smtp.secure,
    auth: { user: s.smtp.user, pass },
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

function smtpFailure(err: unknown): AppFailure {
  const e = err as { code?: string; responseCode?: number; message?: string };
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534) {
    return new AppFailure('SMTP_AUTH', 'SMTP login failed. Check the username and password (Gmail needs an App Password).');
  }
  if (['ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(String(e.code))) {
    return new AppFailure('NETWORK', `Could not connect to the SMTP server: ${e.message}`);
  }
  return new AppFailure('UNKNOWN', e.message ?? String(err));
}

function fromHeader() {
  const s = getSettings().smtp;
  return s.fromName ? { name: s.fromName, address: s.fromEmail } : s.fromEmail;
}

/** Sends one email. List-Unsubscribe lets mail clients show a one-click "unsubscribe". */
async function sendOne(t: nodemailer.Transporter, to: string, subject: string, text: string) {
  const from = getSettings().smtp.fromEmail;
  const info = await t.sendMail({
    from: fromHeader(),
    to,
    subject,
    text,
    headers: { 'List-Unsubscribe': `<mailto:${from}?subject=unsubscribe>` },
  });
  return info.messageId as string | undefined;
}

export async function testSmtp(sendTo?: string): Promise<string> {
  const t = transport();
  try {
    await t.verify();
    if (sendTo) {
      await sendOne(t, sendTo, 'PropLeads test email', 'This is a test email from PropLeads. Your SMTP settings work.');
      return `Connected, and a test email was sent to ${sendTo}.`;
    }
    return 'Connected and logged in to the SMTP server.';
  } catch (err) {
    throw smtpFailure(err);
  } finally {
    t.close();
  }
}

/** Sends one already-composed email (the editor's "Send this to myself"). Defaults to the from address. */
export async function sendPreview(subject: string, text: string, to?: string): Promise<string> {
  const target = to?.trim() || getSettings().smtp.fromEmail;
  const t = transport();
  try {
    await sendOne(t, target, subject, text);
    return `Preview sent to ${target}.`;
  } catch (err) {
    throw smtpFailure(err);
  } finally {
    t.close();
  }
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    wakeUp = () => {
      clearTimeout(timer);
      resolve();
    };
  });

function msUntilMidnight() {
  const d = new Date();
  d.setHours(24, 0, 5, 0);
  return d.getTime() - Date.now();
}

function skipReason(lead: Lead): string | null {
  if (lead.status === 'Do Not Contact') return 'Do Not Contact';
  if (!lead.email) return 'No email address';
  if (db.isSuppressed(lead.email)) return 'Unsubscribed';
  return null;
}

export function startCampaign(id: number): SenderState {
  const c = db.getCampaign(id);
  if (!c) throw new AppFailure('VALIDATION', 'Campaign not found.');
  const tpl = c.templateId ? db.getTemplate(c.templateId) : null;
  if (!tpl) throw new AppFailure('VALIDATION', 'Choose an email template for this campaign first.');
  const problems = validateTemplate(tpl.subject, tpl.body);
  if (problems.length) throw new AppFailure('VALIDATION', problems.join('. ') + '.');
  transport().close(); // throws early when SMTP isn't configured
  db.updateCampaign(id, { status: 'running', statusNote: null });
  ensureLoop();
  return senderState();
}

export function pauseCampaign(id: number): SenderState {
  db.updateCampaign(id, { status: 'paused', statusNote: 'Paused' });
  // Cut the pause between emails short so the loop notices right away.
  if (state.campaignId === id) wakeUp?.();
  return senderState();
}

/** Starts the send loop if it isn't running. Called on start-up too, so running campaigns resume. */
export function ensureLoop() {
  if (loop) {
    wakeUp?.();
    return;
  }
  loop = runLoop().finally(() => {
    loop = null;
    setState({ running: false, campaignId: null, nextSendAt: null });
  });
}

async function runLoop() {
  let t: nodemailer.Transporter | null = null;
  try {
    for (;;) {
      const campaign = db.runningCampaigns()[0];
      if (!campaign) {
        setState({ running: false, campaignId: null, nextSendAt: null, message: 'Idle' });
        return;
      }
      const s = getSettings();

      if (db.sentToday() >= s.dailyEmailCap) {
        const resume = new Date(Date.now() + msUntilMidnight());
        db.updateCampaign(campaign.id, { statusNote: `Daily cap of ${s.dailyEmailCap} reached. Resumes after midnight.` });
        setState({ running: true, campaignId: campaign.id, nextSendAt: resume.toISOString(), message: `Daily cap reached (${s.dailyEmailCap}). Waiting until tomorrow.` });
        await sleep(msUntilMidnight());
        continue;
      }

      const lead = db.nextQueuedLead(campaign.id);
      if (!lead) {
        db.updateCampaign(campaign.id, { status: 'done', statusNote: 'All emails processed' });
        continue;
      }
      const reason = skipReason(lead);
      if (reason) {
        db.markCampaignLead(campaign.id, lead.id, 'skipped', reason);
        setState({ running: true, campaignId: campaign.id, message: `Skipped ${lead.businessName}: ${reason}` });
        continue;
      }
      const tpl = campaign.templateId ? db.getTemplate(campaign.templateId) : null;
      if (!tpl) {
        db.updateCampaign(campaign.id, { status: 'paused', statusNote: 'Template was deleted' });
        continue;
      }

      const { subject, text } = composeEmail(tpl, lead, s.senderFooter);
      setState({ running: true, campaignId: campaign.id, nextSendAt: null, message: `Sending to ${lead.email}…` });
      try {
        t ??= transport();
        const messageId = await sendOne(t, lead.email!, subject, text);
        db.markCampaignLead(campaign.id, lead.id, 'sent');
        db.logEmail({ leadId: lead.id, campaignId: campaign.id, to: lead.email!, subject, messageId: messageId ?? null });
        db.updateLead(lead.id, { status: lead.status === 'New' ? 'Contacted' : lead.status, lastContactedAt: new Date().toISOString() });
      } catch (err) {
        const f = err instanceof AppFailure ? err : smtpFailure(err);
        const e = err as { responseCode?: number };
        // Account-level problems: stop the whole campaign instead of failing every remaining lead.
        if (f.code === 'SMTP_AUTH' || f.code === 'SMTP_NOT_CONFIGURED' || f.code === 'NETWORK' || e.responseCode === 421 || e.responseCode === 454) {
          db.updateCampaign(campaign.id, { status: 'paused', statusNote: f.message });
          setState({ message: f.message });
          t?.close();
          t = null;
          continue;
        }
        // 550-style rejections are about this one address.
        db.markCampaignLead(campaign.id, lead.id, 'failed', f.message);
      }

      const next = new Date(Date.now() + s.emailThrottleSeconds * 1000);
      setState({ running: true, campaignId: campaign.id, nextSendAt: next.toISOString(), message: `Sent to ${lead.email}. Next email at ${next.toLocaleTimeString()}.` });
      await sleep(s.emailThrottleSeconds * 1000);
    }
  } finally {
    t?.close();
  }
}
