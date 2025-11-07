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
};

let cached: GoogleClients | null = null;

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
export async function getGoogle(): Promise<GoogleClients> {
  if (cached) {
    // Check if tokens need refresh
    await refreshTokensIfNeeded(cached.auth);
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

  const tokens = await loadTokens();
  if (tokens) {
    oauth2.setCredentials(tokens);
    // Set up automatic token refresh
    oauth2.on('tokens', async (newTokens) => {
      // Merge new tokens with existing ones
      const currentTokens = oauth2.credentials;
      const updatedTokens = { ...currentTokens, ...newTokens };
      await saveTokens(updatedTokens);
    });
    // Check if tokens need refresh on initial load
    await refreshTokensIfNeeded(oauth2);
  } else {
    await interactiveAuth(oauth2);
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2 });
  const people = google.people({ version: 'v1', auth: oauth2 });

  cached = { calendar, people, auth: oauth2 };
  return cached;
}

// -----------------------------------------------------------------------------
// TOKEN REFRESH HELPER
// -----------------------------------------------------------------------------
async function refreshTokensIfNeeded(oauth2: any): Promise<void> {
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
      console.log('🔄 Refreshing expired access token...');
      const { credentials: newCredentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(newCredentials);
      await saveTokens(newCredentials);
      console.log('✅ Access token refreshed successfully');
    } catch (error: any) {
      console.error('❌ Failed to refresh token:', error.message);
      throw new Error('Token refresh failed. Please re-authenticate by running: pnpm cli auth');
    }
  }
}

// -----------------------------------------------------------------------------
// INTERACTIVE AUTH FLOW
// -----------------------------------------------------------------------------
async function interactiveAuth(oauth2: any) {
  const authUrl = oauth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent'
  });

  await open(authUrl);

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) return;
      const url = new URL(req.url, process.env.GOOGLE_REDIRECT_URI);
      const code = url.searchParams.get('code');
      if (!code) return;

      const { tokens } = await oauth2.getToken(code);
      oauth2.setCredentials(tokens);
      await saveTokens(tokens);

      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('✅ Google authentication complete. You can close this tab.');
      server.close();
    } catch (e: any) {
      res.writeHead(500);
      res.end(e?.message || 'Auth error');
      server.close();
    }
  });

  await new Promise<void>((resolve) => {
    const port = new URL(process.env.GOOGLE_REDIRECT_URI!).port || '5173';
    server.listen(Number(port), () => resolve());
  });
}

// -----------------------------------------------------------------------------
// TOKEN STORAGE (global location)
// -----------------------------------------------------------------------------
function cfgDir() {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'mcp-meet');
}
const TOK_PATH = path.join(cfgDir(), 'tokens.json');

async function loadTokens() {
  try {
    const s = await fs.readFile(TOK_PATH, 'utf-8');
    return JSON.parse(s);
  } catch (error: any) {
    if (error.code === 'ENOENT') {
      // File doesn't exist, user needs to authenticate
      return null;
    }
    // Log other errors for debugging
    console.warn(`Failed to load tokens from ${TOK_PATH}:`, error.message);
    return null;
  }
}

async function saveTokens(tokens: any) {
  try {
    await fs.mkdir(cfgDir(), { recursive: true });
    await fs.writeFile(TOK_PATH, JSON.stringify(tokens, null, 2));
    console.error(`✅ Tokens saved to ${TOK_PATH}`);
  } catch (error: any) {
    console.error(`❌ Failed to save tokens to ${TOK_PATH}:`, error.message);
    throw new Error(`Token save failed: ${error.message}`);
  }
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