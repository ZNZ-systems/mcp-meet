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
// MAIN ENTRY: getGoogle()
// -----------------------------------------------------------------------------
export async function getGoogle(): Promise<GoogleClients> {
  if (cached) return cached;

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
  } else {
    await interactiveAuth(oauth2);
  }

  const calendar = google.calendar({ version: 'v3', auth: oauth2 });
  const people = google.people({ version: 'v1', auth: oauth2 });

  cached = { calendar, people, auth: oauth2 };
  return cached;
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
  } catch {
    return null;
  }
}

async function saveTokens(tokens: any) {
  await fs.mkdir(cfgDir(), { recursive: true });
  await fs.writeFile(TOK_PATH, JSON.stringify(tokens, null, 2));
}

// -----------------------------------------------------------------------------
// PEOPLE API — Search Contacts
// -----------------------------------------------------------------------------
export async function searchInvitees(query: string, limit = 10) {
  const { people } = await getGoogle();
  const resp = await people.people.searchContacts({
    query,
    pageSize: limit,
    readMask: 'names,emailAddresses'
  });
  const results =
    resp.data.results?.map((r) => {
      const name = r.person?.names?.[0]?.displayName || '';
      const email = r.person?.emailAddresses?.[0]?.value || '';
      return { name, email };
    }) ?? [];
  return results.filter((r) => r.email);
}

// -----------------------------------------------------------------------------
// CALENDAR API — FreeBusy Lookup
// -----------------------------------------------------------------------------
export async function freeBusy(
  timeMinISO: string,
  timeMaxISO: string,
  attendeesEmails: string[]
) {
  const { calendar } = await getGoogle();
  const items = [
    ...(process.env.CALENDAR_IDS || 'primary').split(',').map((id) => ({ id: id.trim() })),
    ...attendeesEmails.map((e) => ({ id: e.trim() }))
  ];
  const resp = await calendar.freebusy.query({
    requestBody: {
      timeMin: timeMinISO,
      timeMax: timeMaxISO,
      items
    }
  });

  return resp.data.calendars;
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
  const { calendar } = await getGoogle();

  const resp = await calendar.events.insert({
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
  });

  const event = resp.data;
  const meetUrl =
    event.conferenceData?.entryPoints?.find((p) => p.entryPointType === 'video')?.uri ||
    event.hangoutLink ||
    '';

  return {
    id: event.id!,
    htmlLink: event.htmlLink!,
    meetUrl,
    event
  };
}