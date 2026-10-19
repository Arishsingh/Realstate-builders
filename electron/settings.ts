/**
 * App settings, stored as JSON in the user-data folder.
 * Secrets (Google Places API key, SMTP password) are encrypted with Electron safeStorage
 * (macOS Keychain / Windows DPAPI / libsecret) and are never written in plain text
 * or sent to the renderer.
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { Settings, SettingsUpdate } from '../src/shared/types';
import { AppFailure } from './errors';

type Stored = Omit<Settings, 'hasPlacesApiKey' | 'hasSmtpPassword' | 'secureStorageAvailable'> & {
  secrets: { placesApiKey?: string; smtpPassword?: string }; // base64 of safeStorage ciphertext
};

const DEFAULTS: Stored = {
  smtp: { host: '', port: 587, secure: false, user: '', fromName: '', fromEmail: '' },
  emailThrottleSeconds: 30,
  dailyEmailCap: 100,
  defaultRadiusKm: 10,
  perDomainDelayMs: 1000,
  requestTimeoutMs: 10_000,
  enrichEmailsByDefault: true,
  placesMode: 'combined',
  maxPagesPerQuery: 3,
  lookupBuilderContacts: true,
  senderFooter: '',
  secrets: {},
};

let cache: Stored | null = null;
const file = () => path.join(app.getPath('userData'), 'settings.json');

function load(): Stored {
  if (cache) return cache;
  try {
    const raw = JSON.parse(fs.readFileSync(file(), 'utf8')) as Partial<Stored>;
    cache = { ...DEFAULTS, ...raw, smtp: { ...DEFAULTS.smtp, ...raw.smtp }, secrets: { ...raw.secrets } };
  } catch {
    cache = structuredClone(DEFAULTS);
  }
  return cache;
}

function save(s: Stored) {
  cache = s;
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(s, null, 2), { mode: 0o600 });
}

export function getSettings(): Settings {
  const { secrets, ...rest } = load();
  return {
    ...rest,
    hasPlacesApiKey: Boolean(secrets.placesApiKey),
    hasSmtpPassword: Boolean(secrets.smtpPassword),
    secureStorageAvailable: safeStorage.isEncryptionAvailable(),
  };
}

const clamp = (n: unknown, min: number, max: number, fallback: number) => {
  const v = Number(n);
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
};

export function updateSettings(patch: SettingsUpdate): Settings {
  const cur = load();
  const next: Stored = { ...cur, smtp: { ...cur.smtp, ...patch.smtp }, secrets: { ...cur.secrets } };

  if (patch.emailThrottleSeconds !== undefined) next.emailThrottleSeconds = clamp(patch.emailThrottleSeconds, 5, 3600, 30);
  if (patch.dailyEmailCap !== undefined) next.dailyEmailCap = clamp(patch.dailyEmailCap, 1, 2000, 100);
  if (patch.defaultRadiusKm !== undefined) next.defaultRadiusKm = clamp(patch.defaultRadiusKm, 1, 50, 10);
  if (patch.perDomainDelayMs !== undefined) next.perDomainDelayMs = clamp(patch.perDomainDelayMs, 1000, 60_000, 1000);
  if (patch.requestTimeoutMs !== undefined) next.requestTimeoutMs = clamp(patch.requestTimeoutMs, 2000, 60_000, 10_000);
  if (patch.maxPagesPerQuery !== undefined) next.maxPagesPerQuery = clamp(patch.maxPagesPerQuery, 1, 3, 3);
  if (patch.lookupBuilderContacts !== undefined) next.lookupBuilderContacts = Boolean(patch.lookupBuilderContacts);
  if (patch.enrichEmailsByDefault !== undefined) next.enrichEmailsByDefault = Boolean(patch.enrichEmailsByDefault);
  if (patch.placesMode === 'combined' || patch.placesMode === 'details') next.placesMode = patch.placesMode;
  if (patch.senderFooter !== undefined) next.senderFooter = String(patch.senderFooter).slice(0, 500);
  if (patch.smtp?.port !== undefined) next.smtp.port = clamp(patch.smtp.port, 1, 65535, 587);

  for (const key of ['placesApiKey', 'smtpPassword'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value.trim() === '') {
      delete next.secrets[key];
      continue;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      throw new AppFailure(
        'SECURE_STORAGE_UNAVAILABLE',
        'Secure storage is not available on this system, so secrets cannot be saved. On Linux, install and unlock a keyring (gnome-keyring or KWallet).',
      );
    }
    next.secrets[key] = safeStorage.encryptString(value.trim()).toString('base64');
  }

  save(next);
  return getSettings();
}

export function getSecret(key: 'placesApiKey' | 'smtpPassword'): string | null {
  const enc = load().secrets[key];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'));
  } catch {
    return null;
  }
}
