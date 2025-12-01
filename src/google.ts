import 'dotenv/config';
import { google } from 'googleapis';
import http from 'http';
import open from 'open';
import { URL } from 'url';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';

// -----------------------------------------------------------------------------
// GOOGLE OAUTH SCOPES
// -----------------------------------------------------------------------------
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/contacts.readonly'
];

// -----------------------------------------------------------------------------
// CLIENT TYPES
// -----------------------------------------------------------------------------
export type GoogleClients = {
  calendar: ReturnType<typeof google.calendar>;
  people: ReturnType<typeof google.people>;
  auth: any;
  email: string;
};

// Multi-account token storage types
type Credentials = {
  access_token?: string;
  refresh_token?: string;
  expiry_date?: number;
  token_type?: string;
  scope?: string;
};

type AccountEntry = {
  label?: string;
  tokens: Credentials;
};

type TokenStore = {
  accounts: Record<string, AccountEntry>;
  defaultAccount: string | null;
};

// Cache clients per account email
const clientCache = new Map<string, GoogleClients>();

// -----------------------------------------------------------------------------
// HELPER: Extract Meet URL from event
// -----------------------------------------------------------------------------
function extractMeetUrl(event: any): string {
  return (
    event.conferenceData?.entryPoints?.find((p: any) => p.entryPointType === 'video')?.uri ||
    event.hangoutLink ||
    ''
  );
}

// -----------------------------------------------------------------------------
// HELPER: Retry with exponential backoff
// -----------------------------------------------------------------------------
async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  operationName: string,
  maxRetries = 4
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error: any) {
      lastError = error;

      // Check if error is retryable
      const isRetryable = isRetryableError(error);
      const isLastAttempt = attempt === maxRetries;

      if (!isRetryable || isLastAttempt) {
        throw error;
      }

      // Calculate exponential backoff: 1s, 2s, 4s, 8s
      const delayMs = Math.pow(2, attempt) * 1000;
      console.error(
        `⚠️ ${operationName} failed (attempt ${attempt + 1}/${maxRetries + 1}): ${error.message}. Retrying in ${delayMs / 1000}s...`
      );

      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

// Check if an error is retryable
function isRetryableError(error: any): boolean {
  // Network errors
  if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ENOTFOUND') {
    return true;
  }

  // HTTP status codes that are retryable
  const retryableStatusCodes = [429, 500, 502, 503, 504];
  if (error.response?.status && retryableStatusCodes.includes(error.response.status)) {
    return true;
  }

  // Google API specific errors - check structured error fields first
  // Google API errors have an `errors` array with `reason` field
  const reasons = error.response?.data?.error?.errors?.map((e: any) => e.reason) || [];
  const retryableReasons = [
    'rateLimitExceeded',
    'quotaExceeded',
    'userRateLimitExceeded',
    'backendError',
    'internalError'
  ];
  if (reasons.some((reason: string) => retryableReasons.includes(reason))) {
    return true;
  }

  // Fallback to message checking for backwards compatibility
  if (error.message?.includes('quota') || error.message?.includes('rate limit')) {
    return true;
  }

  return false;
}

// -----------------------------------------------------------------------------
// MAIN ENTRY: getGoogle()
// -----------------------------------------------------------------------------
export async function getGoogle(accountEmail?: string): Promise<GoogleClients> {
  const store = await loadTokenStore();

  // Determine which account to use
  let targetEmail = accountEmail || store.defaultAccount;

  // Handle legacy migration: if we have a _legacy_ account, try to identify it
  if (targetEmail === '_legacy_' && store.accounts['_legacy_']) {
    // We need to identify this account - will happen on first use
    targetEmail = '_legacy_';
  }

  // Check cache first
  if (targetEmail && clientCache.has(targetEmail)) {
    const cached = clientCache.get(targetEmail)!;
    await refreshTokensIfNeeded(cached.auth, targetEmail);
    return cached;
  }

  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error('Missing Google OAuth env vars');
  }

  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  const tokens = targetEmail ? await loadTokens(targetEmail) : null;

  if (tokens) {
    oauth2.setCredentials(tokens);

    // For legacy accounts, identify the email now
    if (targetEmail === '_legacy_') {
      const people = google.people({ version: 'v1', auth: oauth2 });
      const actualEmail = await fetchAuthenticatedUserEmail(people);
      if (actualEmail) {
        // Migrate from _legacy_ to real email
        await saveTokens(tokens, actualEmail, store.accounts['_legacy_']?.label);
        targetEmail = actualEmail;
        console.log(`✅ Migrated legacy account to ${actualEmail}`);
      }
    }

    // Set up automatic token refresh with account context
    const emailForRefresh = targetEmail!;
    oauth2.on('tokens', async (newTokens) => {
      const currentTokens = oauth2.credentials;
      const updatedTokens = { ...currentTokens, ...newTokens };
      await saveTokens(updatedTokens as Credentials, emailForRefresh);
    });

    await refreshTokensIfNeeded(oauth2, targetEmail!);
  } else {
    // No tokens - need interactive auth
    const result = await interactiveAuth(oauth2);
    targetEmail = result.email;
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2 });
  const people = google.people({ version: 'v1', auth: oauth2 });

  const clients: GoogleClients = { calendar, people, auth: oauth2, email: targetEmail! };
  clientCache.set(targetEmail!, clients);
  return clients;
}

// Fetch the email of the authenticated user
async function fetchAuthenticatedUserEmail(people: ReturnType<typeof google.people>): Promise<string | null> {
  try {
    const resp = await people.people.get({
      resourceName: 'people/me',
      personFields: 'emailAddresses'
    });
    const emails = resp.data.emailAddresses;
    if (emails && emails.length > 0) {
      // Prefer the primary email, otherwise use the first one
      const primary = emails.find(e => e.metadata?.primary);
      return (primary?.value || emails[0].value || '').toLowerCase();
    }
  } catch (error: any) {
    console.warn('Failed to fetch user email:', error.message);
  }
  return null;
}

// -----------------------------------------------------------------------------
// TOKEN REFRESH HELPER
// -----------------------------------------------------------------------------
async function refreshTokensIfNeeded(oauth2: any, accountEmail: string): Promise<void> {
  const credentials = oauth2.credentials;

  // If no credentials or no expiry time, skip
  if (!credentials || !credentials.expiry_date) {
    return;
  }

  // Check if token expires in the next 5 minutes (300000 ms)
  const expiryTime = credentials.expiry_date;
  const now = Date.now();
  const bufferTime = 5 * 60 * 1000; // 5 minutes

  if (expiryTime - now < bufferTime) {
    try {
      console.log(`🔄 Refreshing expired access token for ${accountEmail}...`);
      const { credentials: newCredentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(newCredentials);
      await saveTokens(newCredentials, accountEmail);
      console.log('✅ Access token refreshed successfully');
    } catch (error: any) {
      console.error('❌ Failed to refresh token:', error.message);
      throw new Error(`Token refresh failed for ${accountEmail}. Please re-authenticate by running: pnpm cli auth ${accountEmail}`);
    }
  }
}

// -----------------------------------------------------------------------------
// INTERACTIVE AUTH FLOW
// -----------------------------------------------------------------------------
type AuthResult = { email: string; label?: string };

async function interactiveAuth(oauth2: any, label?: string): Promise<AuthResult> {
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  console.log('🔐 Opening browser for Google authentication...');
  await open(authUrl);

  return new Promise<AuthResult>((resolveAuth, rejectAuth) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (!req.url) return;
        const url = new URL(req.url, process.env.GOOGLE_REDIRECT_URI);
        const code = url.searchParams.get('code');
        if (!code) return;

        const { tokens } = await oauth2.getToken(code);
        oauth2.setCredentials(tokens);

        // Fetch the authenticated user's email
        const people = google.people({ version: 'v1', auth: oauth2 });
        const email = await fetchAuthenticatedUserEmail(people);

        if (!email) {
          res.writeHead(500);
          res.end('❌ Failed to determine your email address. Please try again.');
          server.close();
          rejectAuth(new Error('Could not determine authenticated user email'));
          return;
        }

        // Save tokens with the actual email
        await saveTokens(tokens, email, label);

        // Set up automatic token refresh with account context
        oauth2.on('tokens', async (newTokens: any) => {
          const currentTokens = oauth2.credentials;
          const updatedTokens = { ...currentTokens, ...newTokens };
          await saveTokens(updatedTokens as Credentials, email);
        });

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <html>
            <body style="font-family: system-ui; padding: 40px; text-align: center;">
              <h1>✅ Authentication Complete</h1>
              <p>Signed in as <strong>${email}</strong>${label ? ` (${label})` : ''}</p>
              <p>You can close this tab.</p>
            </body>
          </html>
        `);
        server.close();
        resolveAuth({ email, label });
      } catch (e: any) {
        res.writeHead(500);
        res.end(e?.message || 'Auth error');
        server.close();
        rejectAuth(e);
      }
    });

    const port = new URL(process.env.GOOGLE_REDIRECT_URI!).port || '5173';
    server.listen(Number(port), () => {
      console.log(`Waiting for OAuth callback on port ${port}...`);
    });
  });
}

// Auth entry point for CLI (with optional email hint and label)
export async function authenticateAccount(emailHint?: string, label?: string): Promise<AuthResult> {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI } = process.env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REDIRECT_URI) {
    throw new Error('Missing Google OAuth env vars');
  }

  const oauth2 = new google.auth.OAuth2(
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    GOOGLE_REDIRECT_URI
  );

  // If emailHint is provided and we already have tokens for that account, just verify
  if (emailHint) {
    const existingTokens = await loadTokens(emailHint);
    if (existingTokens) {
      console.log(`Account ${emailHint} is already authenticated.`);
      // Update label if provided
      if (label) {
        await saveTokens(existingTokens, emailHint, label);
        console.log(`Updated label to "${label}"`);
      }
      return { email: emailHint, label };
    }
  }

  // Run interactive auth
  const result = await interactiveAuth(oauth2, label);
  console.log(`\n✅ Authenticated as ${result.email}${result.label ? ` (${result.label})` : ''}`);
  return result;
}

// -----------------------------------------------------------------------------
// TOKEN STORAGE (multi-account)
// -----------------------------------------------------------------------------
function cfgDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'mcp-meet');
}
const TOK_PATH = path.join(cfgDir(), 'tokens.json');

// Check if data is old flat format (has access_token at root)
function isLegacyFormat(data: any): boolean {
  return data && typeof data === 'object' && 'access_token' in data && !('accounts' in data);
}

// Load the full token store (handles migration from legacy format)
async function loadTokenStore(): Promise<TokenStore> {
  try {
    const s = await fs.readFile(TOK_PATH, 'utf-8');
    const data = JSON.parse(s);

    // Migrate legacy single-account format
    if (isLegacyFormat(data)) {
      console.log('🔄 Migrating legacy token format to multi-account...');
      // We'll determine the email during auth, for now use placeholder
      const store: TokenStore = {
        accounts: {
          '_legacy_': { tokens: data }
        },
        defaultAccount: '_legacy_'
      };
      return store;
    }

    return data as TokenStore;
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      return { accounts: {}, defaultAccount: null };
    }
    console.warn(`Failed to load tokens from ${TOK_PATH}:`, error.message);
    return { accounts: {}, defaultAccount: null };
  }
}

// Save the full token store
async function saveTokenStore(store: TokenStore): Promise<void> {
  try {
    await fs.mkdir(cfgDir(), { recursive: true });
    await fs.writeFile(TOK_PATH, JSON.stringify(store, null, 2));
  } catch (error: any) {
    console.error(`❌ Failed to save tokens to ${TOK_PATH}:`, error.message);
    throw new Error(`Token save failed: ${error.message}`);
  }
}

// Load tokens for a specific account (or default)
async function loadTokens(email?: string): Promise<Credentials | null> {
  const store = await loadTokenStore();
  const targetEmail = email || store.defaultAccount;
  if (!targetEmail) return null;
  return store.accounts[targetEmail]?.tokens || null;
}

// Save tokens for a specific account
async function saveTokens(tokens: Credentials, email: string, label?: string): Promise<void> {
  const store = await loadTokenStore();

  // Remove legacy placeholder if it exists and we're saving a real account
  if (store.accounts['_legacy_'] && email !== '_legacy_') {
    delete store.accounts['_legacy_'];
    if (store.defaultAccount === '_legacy_') {
      store.defaultAccount = email;
    }
  }

  store.accounts[email] = {
    label: label || store.accounts[email]?.label,
    tokens
  };

  // Set as default if it's the first account
  if (!store.defaultAccount || store.defaultAccount === '_legacy_') {
    store.defaultAccount = email;
  }

  await saveTokenStore(store);
  console.error(`✅ Tokens saved for ${email}`);
}

// List all configured accounts
export async function listAccounts(): Promise<{ email: string; label?: string; isDefault: boolean }[]> {
  const store = await loadTokenStore();
  return Object.entries(store.accounts)
    .filter(([email]) => email !== '_legacy_')
    .map(([email, entry]) => ({
      email,
      label: entry.label,
      isDefault: email === store.defaultAccount
    }));
}

// Remove an account
export async function removeAccount(email: string): Promise<boolean> {
  const store = await loadTokenStore();
  if (!store.accounts[email]) {
    return false;
  }
  delete store.accounts[email];
  clientCache.delete(email);

  // Update default if we removed the default account
  if (store.defaultAccount === email) {
    const remaining = Object.keys(store.accounts).filter(e => e !== '_legacy_');
    store.defaultAccount = remaining[0] || null;
  }

  await saveTokenStore(store);
  return true;
}

// Set the default account
export async function setDefaultAccount(email: string): Promise<boolean> {
  const store = await loadTokenStore();
  if (!store.accounts[email]) {
    return false;
  }
  store.defaultAccount = email;
  await saveTokenStore(store);
  return true;
}

// Get the default account email
export async function getDefaultAccount(): Promise<string | null> {
  const store = await loadTokenStore();
  return store.defaultAccount;
}

// Resolve account hint (email or label) to email
export async function resolveAccountHint(hint: string): Promise<string | null> {
  const store = await loadTokenStore();

  // Direct email match
  if (store.accounts[hint]) {
    return hint;
  }

  // Label match
  for (const [email, entry] of Object.entries(store.accounts)) {
    if (entry.label?.toLowerCase() === hint.toLowerCase()) {
      return email;
    }
  }

  return null;
}

// Resolve which account to use based on hint and/or attendee domains
export async function resolveAccount(
  hint?: string,
  attendeeEmails?: string[]
): Promise<string | null> {
  const store = await loadTokenStore();
  const accounts = Object.entries(store.accounts).filter(([e]) => e !== '_legacy_');

  if (accounts.length === 0) {
    return null;
  }

  // 1. If hint provided, resolve it
  if (hint) {
    const resolved = await resolveAccountHint(hint);
    if (resolved) return resolved;
    // Hint didn't match any account — continue with inference
    console.warn(`Account hint "${hint}" not found, using inference...`);
  }

  // 2. If only one account, use it
  if (accounts.length === 1) {
    return accounts[0][0];
  }

  // 3. Domain matching: find account whose domain matches most attendees
  if (attendeeEmails && attendeeEmails.length > 0) {
    const domainCounts = new Map<string, number>();

    // Count attendee domains
    for (const email of attendeeEmails) {
      const domain = email.split('@')[1]?.toLowerCase();
      if (domain) {
        domainCounts.set(domain, (domainCounts.get(domain) || 0) + 1);
      }
    }

    // Find account with matching domain
    for (const [accountEmail] of accounts) {
      const accountDomain = accountEmail.split('@')[1]?.toLowerCase();
      if (accountDomain && domainCounts.has(accountDomain)) {
        return accountEmail;
      }
    }
  }

  // 4. Fall back to default account
  return store.defaultAccount;
}

// -----------------------------------------------------------------------------
// PEOPLE API — Search Contacts
// -----------------------------------------------------------------------------
export async function searchInvitees(query: string, limit = 10) {
  try {
    const { people } = await getGoogle();
    const resp = await retryWithBackoff(
      () => people.people.searchContacts({
        query,
        pageSize: limit,
        readMask: 'names,emailAddresses'
      }),
      `Search contacts for "${query}"`
    );
    const results =
      resp.data.results?.map((r) => {
        const name = r.person?.names?.[0]?.displayName || '';
        const email = r.person?.emailAddresses?.[0]?.value || '';
        return { name, email };
      }) ?? [];
    return results.filter((r) => r.email);
  } catch (error: any) {
    throw new Error(`Failed to search contacts for "${query}": ${error.message}`);
  }
}

// -----------------------------------------------------------------------------
// PEOPLE API — Resolve Name or Email to Email Address
// -----------------------------------------------------------------------------
/**
 * Resolves a name or email to an email address.
 * - If input is already an email, returns it as-is
 * - If input is a name, searches contacts and returns the email if exactly one match is found
 * - Throws an error if contact cannot be uniquely identified
 */
export async function resolveToEmail(nameOrEmail: string): Promise<{ email: string; displayName?: string }> {
  const trimmed = nameOrEmail.trim();

  if (!trimmed) {
    throw new Error('Attendee name or email cannot be empty');
  }

  // Check if it's already an email with improved validation
  // RFC 5322 compliant email pattern (simplified)
  const emailPattern = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  if (emailPattern.test(trimmed)) {
    // Validate email format more thoroughly
    if (trimmed.length > 254) {
      throw new Error(`Email address "${trimmed}" is too long (maximum 254 characters)`);
    }
    const [localPart, domain] = trimmed.split('@');
    if (localPart.length > 64) {
      throw new Error(`Email address "${trimmed}" has an invalid local part (maximum 64 characters before @)`);
    }
    return { email: trimmed.toLowerCase() };
  }

  // Not an email, search contacts by name
  const results = await searchInvitees(trimmed, 10);

  // Only use the contact if we found exactly one match with an email
  if (results.length === 1) {
    return { email: results[0].email.toLowerCase(), displayName: results[0].name };
  }

  // Provide clear error messages for different scenarios
  if (results.length === 0) {
    throw new Error(
      `No contact found for "${trimmed}". Please provide their email address directly or check the spelling of their name.`
    );
  }

  // Multiple matches found - provide helpful suggestions
  const matchList = results.slice(0, 5).map(r => `  - ${r.name} (${r.email})`).join('\n');
  throw new Error(
    `Multiple contacts found for "${trimmed}":\n${matchList}\n\nPlease provide a specific email address or use a more specific name.`
  );
}

// -----------------------------------------------------------------------------
// PEOPLE API — Resolve Multiple Names/Emails to Email Addresses
// -----------------------------------------------------------------------------
/**
 * Resolves an array of names and/or emails to email addresses with display names.
 * Each entry can be either a name or an email address.
 * Resolves all attendees in parallel for better performance.
 * Also detects and removes duplicate attendees.
 */
export async function resolveAttendeesToEmails(
  namesOrEmails: string[]
): Promise<{ email: string; displayName?: string }[]> {
  if (!namesOrEmails || namesOrEmails.length === 0) {
    throw new Error('At least one attendee is required');
  }

  try {
    // Resolve all attendees in parallel
    const resolved = await Promise.all(
      namesOrEmails.map(async (nameOrEmail) => {
        try {
          return await resolveToEmail(nameOrEmail);
        } catch (error) {
          // Re-throw with context about which attendee failed
          const message = error instanceof Error ? error.message : String(error);
          throw new Error(`Failed to resolve attendee "${nameOrEmail}": ${message}`);
        }
      })
    );

    // Check for duplicate email addresses
    const emailMap = new Map<string, { email: string; displayName?: string }>();
    const duplicates: string[] = [];

    for (const attendee of resolved) {
      const normalizedEmail = attendee.email.toLowerCase();
      if (emailMap.has(normalizedEmail)) {
        duplicates.push(attendee.email);
      } else {
        emailMap.set(normalizedEmail, attendee);
      }
    }

    if (duplicates.length > 0) {
      console.warn(`⚠️ Removed duplicate attendees: ${duplicates.join(', ')}`);
    }

    // Return unique attendees
    return Array.from(emailMap.values());
  } catch (error) {
    // Re-throw the error as-is (already has context from the map)
    throw error;
  }
}

// -----------------------------------------------------------------------------
// CALENDAR API — FreeBusy Lookup
// -----------------------------------------------------------------------------
export async function freeBusy(
  timeMinISO: string,
  timeMaxISO: string,
  attendeesEmails: string[]
) {
  try {
    const { calendar } = await getGoogle();
    const items = [
      ...(process.env.CALENDAR_IDS || 'primary').split(',').map((id) => ({ id: id.trim() })),
      ...attendeesEmails.map((e) => ({ id: e.trim() }))
    ];
    const resp = await retryWithBackoff(
      () => calendar.freebusy.query({
        requestBody: {
          timeMin: timeMinISO,
          timeMax: timeMaxISO,
          items
        }
      }),
      `Query free/busy for ${timeMinISO} to ${timeMaxISO}`
    );

    return resp.data.calendars;
  } catch (error: any) {
    throw new Error(`Failed to query free/busy information for time range ${timeMinISO} to ${timeMaxISO}: ${error.message}`);
  }
}

// -----------------------------------------------------------------------------
// CALENDAR API — Create Google Meet Event
// -----------------------------------------------------------------------------
export async function createMeetEvent({
  summary,
  description,
  startISO,
  endISO,
  attendees
}: {
  summary: string;
  description?: string;
  startISO: string;
  endISO: string;
  attendees: { email: string; displayName?: string }[];
}) {
  try {
    const { calendar } = await getGoogle();

    const resp = await retryWithBackoff(
      () => calendar.events.insert({
        calendarId: 'primary',
        conferenceDataVersion: 1,
        sendUpdates: 'all',
        requestBody: {
          summary,
          description,
          start: { dateTime: startISO },
          end: { dateTime: endISO },
          attendees: attendees.map((a) => ({
            email: a.email,
            displayName: a.displayName
          })),
          conferenceData: {
            createRequest: {
              requestId: `meet-${Date.now()}`,
              conferenceSolutionKey: { type: 'hangoutsMeet' }
            }
          }
        }
      }),
      `Create meeting "${summary}"`
    );

    const event = resp.data;
    const meetUrl = extractMeetUrl(event);

    return {
      id: event.id!,
      htmlLink: event.htmlLink!,
      meetUrl,
      event
    };
  } catch (error: any) {
    throw new Error(`Failed to create Google Meet event "${summary}": ${error.message}`);
  }
}

// -----------------------------------------------------------------------------
// CALENDAR API — List Meetings
// -----------------------------------------------------------------------------
export async function listMeetings(
  timeMinISO: string,
  timeMaxISO: string,
  maxResults = 50
) {
  try {
    const { calendar } = await getGoogle();

    const resp = await retryWithBackoff(
      () => calendar.events.list({
        calendarId: 'primary',
        timeMin: timeMinISO,
        timeMax: timeMaxISO,
        maxResults,
        singleEvents: true,
        orderBy: 'startTime'
      }),
      `List meetings for ${timeMinISO} to ${timeMaxISO}`
    );

    const events = resp.data.items || [];

    // Filter to only events with Meet links
    const meetEvents = events
      .filter((e) => {
        const meetUrl = extractMeetUrl(e);
        return meetUrl !== '';
      })
      .map((e) => {
        const meetUrl = extractMeetUrl(e);

        return {
          id: e.id!,
          title: e.summary || '(No title)',
          description: e.description || '',
          startISO: e.start?.dateTime || e.start?.date || '',
          endISO: e.end?.dateTime || e.end?.date || '',
          meetUrl,
          attendees: e.attendees?.map((a) => ({
            email: a.email || '',
            displayName: a.displayName || '',
            responseStatus: a.responseStatus || ''
          })) || [],
          htmlLink: e.htmlLink || ''
        };
      });

    return meetEvents;
  } catch (error: any) {
    throw new Error(`Failed to list meetings for time range ${timeMinISO} to ${timeMaxISO}: ${error.message}`);
  }
}

// -----------------------------------------------------------------------------
// CALENDAR API — Get Meeting Details
// -----------------------------------------------------------------------------
export async function getMeetingDetails(eventId: string) {
  try {
    const { calendar } = await getGoogle();

    const resp = await retryWithBackoff(
      () => calendar.events.get({
        calendarId: 'primary',
        eventId
      }),
      `Get meeting details for event ${eventId}`
    );

    const event = resp.data;
    const meetUrl = extractMeetUrl(event);

    return {
      id: event.id!,
      title: event.summary || '(No title)',
      description: event.description || '',
      startISO: event.start?.dateTime || event.start?.date || '',
      endISO: event.end?.dateTime || event.end?.date || '',
      meetUrl,
      attendees: event.attendees?.map((a) => ({
        email: a.email || '',
        displayName: a.displayName || '',
        responseStatus: a.responseStatus || ''
      })) || [],
      htmlLink: event.htmlLink || '',
      created: event.created || '',
      updated: event.updated || '',
      status: event.status || '',
      location: event.location || ''
    };
  } catch (error: any) {
    throw new Error(`Failed to get meeting details for event ID "${eventId}": ${error.message}`);
  }
}

// -----------------------------------------------------------------------------
// CALENDAR API — Update Meeting
// -----------------------------------------------------------------------------
export async function updateMeetEvent(
  eventId: string,
  updates: {
    summary?: string;
    description?: string;
    startISO?: string;
    endISO?: string;
    attendees?: { email: string; displayName?: string }[];
  }
) {
  try {
    const { calendar } = await getGoogle();

    // Build the update payload
    const requestBody: any = {};

    if (updates.summary !== undefined) {
      requestBody.summary = updates.summary;
    }
    if (updates.description !== undefined) {
      requestBody.description = updates.description;
    }
    if (updates.startISO !== undefined) {
      requestBody.start = { dateTime: updates.startISO };
    }
    if (updates.endISO !== undefined) {
      requestBody.end = { dateTime: updates.endISO };
    }
    if (updates.attendees !== undefined) {
      requestBody.attendees = updates.attendees.map((a) => ({
        email: a.email,
        displayName: a.displayName
      }));
    }

    const resp = await retryWithBackoff(
      () => calendar.events.patch({
        calendarId: 'primary',
        eventId,
        conferenceDataVersion: 1,
        sendUpdates: 'all',
        requestBody
      }),
      `Update meeting ${eventId}`
    );

    const event = resp.data;
    const meetUrl = extractMeetUrl(event);

    return {
      id: event.id!,
      htmlLink: event.htmlLink!,
      meetUrl,
      event
    };
  } catch (error: any) {
    throw new Error(`Failed to update meeting with event ID "${eventId}": ${error.message}`);
  }
}

// -----------------------------------------------------------------------------
// CALENDAR API — Delete Meeting
// -----------------------------------------------------------------------------
export async function deleteMeetEvent(eventId: string) {
  try {
    const { calendar } = await getGoogle();

    await retryWithBackoff(
      () => calendar.events.delete({
        calendarId: 'primary',
        eventId,
        sendUpdates: 'all'
      }),
      `Delete meeting ${eventId}`
    );

    return { success: true, eventId };
  } catch (error: any) {
    throw new Error(`Failed to delete meeting with event ID "${eventId}": ${error.message}`);
  }
}