# PropLeads

A desktop app for finding real estate brokers and agents (plots, houses, flats, bungalows, commercial) in a locality, collecting their public contact details, and doing polite outreach.

Type a location ("Baner, Pune", "Andheri West, Mumbai"), choose how many leads you want, and PropLeads returns a table of agents with **name, business name, phone (E.164, mobile/landline), email, website, address, rating, source and date found**. Export to CSV or Excel, or add them to an email campaign. WhatsApp chats can be opened one by one with the message already filled in.

![stack](https://img.shields.io/badge/Electron-React%20%2B%20TypeScript%20%2B%20Vite-blue) ![db](https://img.shields.io/badge/SQLite-better--sqlite3-green)

## Setup

Requires **Node.js 22+** (macOS: Xcode Command Line Tools; Windows: nothing extra, prebuilt binaries are used).

```bash
npm install          # also rebuilds better-sqlite3 for Electron
```

## Run

```bash
npm run dev          # development: Vite hot reload + Electron
npm start            # build everything and open the app
npm test             # unit tests (phone/email/dedupe/robots.txt/templates, plus a local-server enrichment test)
npm run typecheck
```

## Package installers

```bash
npm run package:mac  # .dmg for Apple Silicon and Intel  → release/
npm run package:win  # .exe (NSIS installer)             → release/
npm run package      # current platform
```

Build Windows installers on Windows (or in CI), because native modules have to be compiled for the target platform. The builds are unsigned. On macOS, right-click the app and choose **Open** the first time. For public distribution, add code signing (`CSC_LINK`/`CSC_KEY_PASSWORD`) and notarization.

## First-time configuration (Settings)

### 1. Google Places API key

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project (or pick an existing one).
2. **Billing → Link a billing account.** The Places API doesn't work without billing, even within the free usage.
3. **APIs & Services → Library → "Places API (New)" → Enable.** (Not the legacy "Places API".)
4. **APIs & Services → Credentials → Create credentials → API key.**
5. Restrict the key: *API restrictions → Restrict key → Places API (New)*. Application restrictions can stay "None" for a desktop app.
6. Optional but recommended: **APIs & Services → Places API (New) → Quotas** to set a daily request cap, and **Billing → Budgets & alerts** to set a monthly budget alert.
7. Paste the key in **Settings → Google Places API**, click **Save**, then **Test**.

### 2. SMTP (for email campaigns)

Use your own mailbox. For Gmail: host `smtp.gmail.com`, port `465`, security **SSL/TLS**, username = your address, and an [App Password](https://myaccount.google.com/apppasswords) (needs 2-Step Verification), not your normal password. Outlook/Office 365: `smtp.office365.com`, port `587`, **STARTTLS**. Click **Test login**, then **Send test** to yourself.

### Where secrets live

The Places API key and SMTP password are encrypted with Electron **safeStorage** (macOS Keychain, Windows DPAPI, libsecret on Linux) and stored only as ciphertext in `settings.json`. They are never sent back to the UI; the UI only sees whether a key is saved. If secure storage isn't available (e.g. Linux without a keyring), saving secrets is refused rather than stored in plain text.

Data folder (database `propleads.db`, `settings.json`):
- macOS: `~/Library/Application Support/PropLeads`
- Windows: `%APPDATA%\PropLeads`

## Google Places cost notes

Google bills the Places API (New) per request, by SKU, and each SKU has a free monthly usage allowance. Prices change, so check the current [pricing page](https://developers.google.com/maps/billing-and-pricing/pricing) before relying on these figures. Approximate list prices (USD per 1,000 requests):

| Request | SKU (fields requested) | ~Price / 1,000 |
|---|---|---|
| Text Search with phone/website/rating | Text Search **Enterprise** | ~$35 |
| Text Search with id/name/address only | Text Search **Pro** | ~$32 |
| Place Details with phone/website/rating | Place Details **Enterprise** | ~$20 |
| Location lookup (id + coordinates) | Text Search **Essentials** | low / free tier |

PropLeads has two fetch modes (**Settings → Fetch mode**):

- **Text Search only** (default, cheapest for fresh areas): one request returns up to 20 places *with* contact fields. 100 leads usually takes about 6–15 requests, roughly **$0.20–$0.55**, because some results are duplicates or already in your database.
- **Text Search + Place Details**: Text Search for basic fields, then one Details request per *new* place. Places already in your database are skipped before Details is called. This is cheaper when you search the same area again and again, but more expensive for fresh areas: roughly **$2–2.50 per 100 new leads**.

Other cost facts:
- Google returns at most **60 results per query** (3 pages of 20). PropLeads runs several query variants ("real estate agent in…", "property dealer in…", "plot broker in…" and more per property type) to reach larger numbers. Asking for 500 leads in one small locality usually ends with "Found X of 500 requested". That's normal.
- Website email enrichment does not use Google and costs nothing.
- Set a quota and a budget alert in Cloud Console (step 6 above) so a large search can't surprise you.

## How it works

```
electron/
  main.ts               window + typed IPC handlers (all network work happens in the main process)
  preload.ts            contextBridge → window.api   (contextIsolation on, nodeIntegration off, sandbox on)
  db.ts                 SQLite schema + queries (leads, searches, campaigns, templates, email log, suppressions, RERA)
  settings.ts           settings.json + safeStorage-encrypted secrets
  search.ts             orchestrates sources → normalize → dedupe → save → enrich, with progress + cancel
  normalize.ts          E.164 phones (libphonenumber-js, mobile vs landline), domains, Deduper, wa.me links
  export.ts             CSV (UTF-8 BOM, formula-injection safe) and .xlsx (exceljs)
  leadCsv.ts            CSV lead import: column detection, normalization
  sources/
    types.ts            LeadSource plugin interface
    googlePlaces.ts     Google Places API (New): Text Search (+ optional Place Details)
    rera.ts             RERA registry: CSV import, location search, lead tagging
    reale.ts            reale.in API: RERA builders by location (+ Google contact lookup)
    realeData.ts        pure grouping/filtering helpers for reale.in
    index.ts            source registry (add new plugins here)
  enrich/
    politeFetch.ts      robots.txt, clear User-Agent, ≥1 s between requests per domain, 10 s timeout, size cap
    websiteEmails.ts    homepage + /contact, /contact-us, /about (+ contact link found on the homepage)
    emails.ts           regex + mailto + [at]/(dot) extraction, junk filtering, ranking, robots.txt parser
  outreach/
    template.ts         {{name}} {{business}} {{location}} {{phone}} {{website}} merge, unsubscribe line
    mailer.ts           nodemailer send loop: throttle, daily cap, Do Not Contact checks, resume after restart
src/
  shared/types.ts       types shared by main, preload and UI (IpcApi lists every channel)
  views/                Find Leads, Leads (TanStack Table), Campaigns, Templates, Settings
  components/           UI primitives, toast, add-to-campaign dialog
test/                   vitest unit tests
```

### Search pipeline

1. **Sources** run in order until the requested number is reached. Each source is told what's "known" (already in the database, or already found in this search) and keeps paginating past those, so every search returns *new* leads.
2. **Normalize.** Phones become E.164 (`+91…`) and are classified as mobile or landline. Invalid numbers are kept as raw text but not used for matching.
3. **Deduplicate**, in order, by phone, then email, then website domain. Shared hosts (facebook.com, business.site, justdial.com, 99acres.com…) are ignored for domain matching.
4. **Save.** Each lead is written to SQLite as soon as it's found, with source, search location and timestamps. A cancelled search keeps what it found.
5. **Enrich.** For leads with a website, PropLeads fetches the homepage and contact/about pages, at most one request per second per site, 4 sites in parallel. It respects robots.txt and identifies itself as `PropLeadsBot/1.0`. Emails come from page text and `mailto:` links. Junk is dropped: example.com, image filenames like `logo@2x.png`, Sentry/Wix system addresses, noreply. Addresses on the business's own domain are ranked first. Social-media and listing-portal pages are skipped.
6. If fewer leads exist than requested, you get **"Found X of Y requested"** instead of an error.

## Data sources

| Source | How PropLeads uses it |
|---|---|
| **Google Maps** | Built-in source via the official Google Places API (New): agents' business name, phone, website, address, rating |
| **reale.in** | Built-in source via its free public JSON API ([reale.in/data](https://reale.in/data), CC BY 4.0, credited as "data: reale.in"). Returns **builders/promoters** with RERA-registered projects in the searched area. Covers Rajasthan, Haryana, Kerala, Telangana, Bihar, Odisha, Jharkhand and Himachal Pradesh. The API has no contact details, so when a Google key is set each builder is looked up on Google (one Places request each; turn off in Settings). reale.in's terms forbid using its data to contact individuals, so only organisations (LLP, Pvt Ltd, "Developers", "Builders"…) become leads |
| **State RERA portals**: MahaRERA, GujRERA, UP RERA, K-RERA, Haryana, Rajasthan | Settings → RERA registry has a link to each. Most sit behind CAPTCHAs or bot protection (MahaRERA and K-RERA reject automated requests), so export or copy the registered-agent list there and **Import CSV** in Settings. This tags matching leads "RERA Registered" and makes the list searchable |
| **Justdial, 99acres, Magicbricks, Housing.com, LinkedIn, Google Search, Builders & Projects** | Not read automatically. Their terms prohibit scraping, and several block bots outright (LinkedIn's robots.txt disallows all crawlers; 99acres and Housing.com refuse automated requests). Find Leads → **Search other sites** opens the right search for your location in your browser. Collect the contacts you want into a spreadsheet and use **Leads → Import CSV** |

**Leads → Import CSV** accepts any spreadsheet with a business or name column plus at least one of phone, email or website. Common headers like "Company Name", "Contact Person", "Mobile No", "E-mail" and "City" are recognised. Phones are normalized, duplicates of existing leads are skipped, and the import appears as its own entry in the search filter.

### Errors

| Situation | What you see |
|---|---|
| No / invalid API key | "Your Google Places API key is not valid", with a link to Settings |
| API not enabled / billing off | Google's message + "enable Places API (New) and billing" |
| Quota exceeded (HTTP 429) | "Google Places quota exceeded…". Leads found so far are kept |
| Network failure | Google calls retry twice with backoff, then show a network error; website fetch failures just skip that site |
| SMTP login failure / connection loss | The campaign pauses with the reason (no lead is marked failed) |
| Single address rejected | That recipient is marked *failed* with the server's message; the campaign continues |

### Adding a lead source

Implement `LeadSource` (`electron/sources/types.ts`) and add it to `SOURCES` in `electron/sources/index.ts`:

```ts
export const mySource: LeadSource = {
  id: 'my_source',
  name: 'My Source',
  description: 'Shown in the search screen',
  unavailableReason: () => null,               // or e.g. 'Add an API key in Settings'
  async search(location, limit, filters, ctx) {
    const out: RawLead[] = [];
    // …fetch…; for each candidate:
    //   if (ctx.isKnown(lead)) continue;      // already stored → skip, keep paging
    //   out.push(lead); ctx.onLead?.(lead);   // saves it and moves the progress bar
    //   honour ctx.signal for cancel
    return out;
  },
};
```

## Outreach

- **Templates** support `{{name}}`, `{{business}}`, `{{location}}`, `{{phone}}`, `{{website}}`, with fallbacks: `{{name|there}}`. `{{name}}` falls back to the business name. Sending is blocked while a template has unknown placeholders or leftover `[bracketed]` text.
- **Every email** ends with an unsubscribe line (plus your optional footer) and carries a `List-Unsubscribe` header.
- **Sending** is one email at a time through your SMTP account, with a pause between emails (default 30 s) and a daily cap (default 100). When the cap is hit, sending waits until midnight. Running campaigns resume when the app restarts.
- **Statuses:** New, Contacted, Replied, Interested, Not Interested, Do Not Contact. Sending an email (or opening its WhatsApp chat) moves a *New* lead to *Contacted*. Update the rest from the Leads table.
- **Do Not Contact** leads are never added to campaigns, are skipped right before sending, and their email addresses go on a suppression list that survives deleting the lead.
- **WhatsApp**: PropLeads only builds `wa.me` click-to-chat links with the message pre-filled. You press send yourself in WhatsApp. Nothing is sent automatically. Links are also included in exports for mobile numbers.

## RERA registry (optional)

**Settings → RERA registry → Import CSV** accepts an agent list exported from a state RERA site (e.g. MahaRERA). PropLeads needs a registration-number column; name, firm, phone, email, address and district columns are detected automatically. Imported agents then:
- tag matching leads (by phone, email or firm name) as **RERA Registered**, shown as a ✓ next to the business name and in the *RERA Number* export column;
- become a searchable source: agents whose address/district matches the searched location.

## Responsible use

PropLeads collects only business contact details that businesses publish themselves: Google business listings and their own websites. Follow the laws that apply to you before contacting anyone: India's DPDP Act 2023, TRAI rules for commercial calls/SMS (check the DND/NCPR registry before calling), and anti-spam rules for email. Keep volumes low, personalise messages, and honour every opt-out.
