import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getGoogle, searchInvitees, freeBusy, createMeetEvent, listMeetings, getMeetingDetails, updateMeetEvent, deleteMeetEvent, resolveAttendeesToEmails } from './google.js';
import { addToAppleCalendar, updateAppleCalendarEvent, deleteAppleCalendarEvent } from './apple.js';
import { computeCommonFree, googleFreeBusyToBusyMap } from './availability.js';
import { parseDateWindow } from './date-utils.js';

/* ---------------------------------- Utils --------------------------------- */
// Validate ISO 8601 date string
function validateISODate(dateString: string, fieldName: string): void {
  // Validate strict ISO 8601 format: YYYY-MM-DDTHH:mm:ss.sssZ or YYYY-MM-DDTHH:mm:ssZ or with timezone offset
  const iso8601Regex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?(Z|[+-]\d{2}:\d{2})$/;
  if (!iso8601Regex.test(dateString)) {
    throw new Error(`Invalid ISO 8601 format for ${fieldName}: ${dateString}. Expected format: YYYY-MM-DDTHH:mm:ss.sssZ or YYYY-MM-DDTHH:mm:ssZ`);
  }

  const date = new Date(dateString);
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date value for ${fieldName}: ${dateString}`);
  }
}

// Validate that start date is before end date
function validateDateRange(startISO: string, endISO: string): void {
  const start = new Date(startISO);
  const end = new Date(endISO);

  if (start.getTime() >= end.getTime()) {
    throw new Error(`Start date (${startISO}) must be before end date (${endISO})`);
  }
}

// Validate that time window is reasonable (not too long)
function validateTimeWindow(startISO: string, endISO: string, maxDays = 365): void {
  const start = new Date(startISO);
  const end = new Date(endISO);
  const diffMs = end.getTime() - start.getTime();
  const diffDays = diffMs / (1000 * 60 * 60 * 24);

  if (diffDays > maxDays) {
    throw new Error(`Time window is too large (${diffDays.toFixed(1)} days). Maximum allowed is ${maxDays} days.`);
  }
}

// Validate meeting duration is reasonable
function validateDuration(durationMinutes: number): void {
  if (durationMinutes < 1) {
    throw new Error(`Meeting duration must be at least 1 minute (got ${durationMinutes})`);
  }

  if (durationMinutes > 1440) { // 24 hours
    throw new Error(`Meeting duration is too long (${durationMinutes} minutes). Maximum is 1440 minutes (24 hours).`);
  }
}

// find a contiguous run of small slots whose combined span >= duration
function pickContiguous(
  slots: { startISO: string; endISO: string }[],
  durationMinutes: number
): { startISO: string; endISO: string } | null {
  if (!slots.length) return null;
  const neededMs = durationMinutes * 60 * 1000;
  let accStart = new Date(slots[0].startISO);
  let accEnd = new Date(slots[0].endISO);

  for (let i = 1; i < slots.length; i++) {
    const prevEnd = accEnd;
    const nextStart = new Date(slots[i].startISO);
    const nextEnd = new Date(slots[i].endISO);

    if (nextStart.getTime() === prevEnd.getTime()) {
      accEnd = nextEnd;
    } else {
      if (accEnd.getTime() - accStart.getTime() >= neededMs) break;
      accStart = nextStart;
      accEnd = nextEnd;
    }
  }
  if (accEnd.getTime() - accStart.getTime() >= neededMs) {
    return {
      startISO: accStart.toISOString(),
      endISO: new Date(accStart.getTime() + neededMs).toISOString()
    };
  }
  return null;
}

/* ------------------------------- MCP SERVER ------------------------------- */
async function startMcp() {
  const server = new McpServer({
    name: 'mcp-meet',
    version: '0.4.0'
  });

  // Tool: search_invitees
  server.registerTool(
    'search_invitees',
    {
      title: 'Search invitees',
      description: 'Find contacts by name/email via Google People API.',
      // ZodRawShape (shape object), not z.object(...)
      inputSchema: {
        query: z.string(),
        limit: z.number().int().positive().optional()
      }
      // No outputSchema (prevents schema crashes in some SDK builds)
    },
    async ({ query, limit }) => {
      const out = await searchInvitees(query, limit ?? 10);
      const payload = { results: out };
      return {
        content: [
          { 
            type: 'text', 
            text: `✅ Found ${out.length} contact(s) for "${query}".\n\n${JSON.stringify(payload, null, 2)}` 
          } as const
        ]
      };
    }
  );

  // Tool: find_slots
  server.registerTool(
    'find_slots',
    {
      title: 'Find common free slots',
      description: 'Compute shared availability across attendees using Google freeBusy. Attendees can be specified by name or email address - names will be automatically resolved to emails via Google Contacts.',
      inputSchema: {
        attendees: z.array(z.string()),
        window: z.string().optional(),
        windowStartISO: z.string().optional(),
        windowEndISO: z.string().optional(),
        slotMinutes: z.number().int().positive().optional()
      }
      // No outputSchema
    },
    async ({ attendees, window, windowStartISO, windowEndISO, slotMinutes }) => {
      if (window && (windowStartISO || windowEndISO)) {
        throw new Error('Cannot provide both `window` and ISO start/end times.');
      }
      if (!window && (!windowStartISO || !windowEndISO)) {
        throw new Error('Must provide either `window` or both ISO start/end times.');
      }

      let start: string, end: string;
      if (window) {
        ({ startISO: start, endISO: end } = parseDateWindow(window));
      } else {
        start = windowStartISO!;
        end = windowEndISO!;
      }

      validateISODate(start, 'windowStartISO');
      validateISODate(end, 'windowEndISO');
      validateDateRange(start, end);
      validateTimeWindow(start, end, 90); // Max 90 days for availability search

      // Resolve attendees (names or emails) to email addresses
      const resolvedAttendees = await resolveAttendeesToEmails(attendees);
      const attendeeEmails = resolvedAttendees.map(a => a.email);

      const calendars = await freeBusy(start, end, attendeeEmails);
      const busyMap = googleFreeBusyToBusyMap(calendars);
      const slots = computeCommonFree({
        windowStartISO: start,
        windowEndISO: end,
        busyMaps: busyMap,
        slotMinutes: slotMinutes ?? 30
      });
      const top = slots.slice(0, 50);
      const payload = { results: top };
      const human =
        top.length === 0
          ? '❌ No common free slots in the window.'
          : `✅ ${top.length} slot(s) found. Showing up to 50.`;
      return {
        content: [
          { type: 'text', text: `${human}\n\n${JSON.stringify(payload, null, 2)}` } as const
        ]
      };
    }
  );

  // Tool: create_meet_and_calendar
  server.registerTool(
    'create_meet_and_calendar',
    {
      title: 'Create Meet + Apple Calendar event',
      description:
        'Creates a Google Calendar event with a Meet link and mirrors it to Apple Calendar. Attendees can be specified by name or email address - names will be automatically resolved to emails via Google Contacts.',
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        startISO: z.string(),
        endISO: z.string(),
        attendees: z.array(z.string()),
        appleCalendarName: z.string().optional()
      }
      // No outputSchema
    },
    async ({ title, description, startISO, endISO, attendees, appleCalendarName }) => {
      validateISODate(startISO, 'startISO');
      validateISODate(endISO, 'endISO');
      validateDateRange(startISO, endISO);

      // Resolve attendees (names or emails) to email addresses
      const resolvedAttendees = await resolveAttendeesToEmails(attendees);

      const result = await createMeetEvent({
        summary: title,
        description,
        startISO,
        endISO,
        attendees: resolvedAttendees
      });

      const appleResult = await addToAppleCalendar({
        calendarName: appleCalendarName || process.env.APPLE_CALENDAR_NAME || 'Meetings',
        title,
        notes: `Google Meet: ${result.meetUrl}\n\n${description || ''}`,
        location: result.meetUrl,
        startISO,
        endISO,
        attendees: resolvedAttendees
      });

      const payload = {
        meetUrl: result.meetUrl,
        eventHtml: result.htmlLink,
        appleCalendarSync: appleResult
      };

      let message = `✅ Meeting created.\n🔗 Meet: ${result.meetUrl}`;
      if (!appleResult.ok) {
        message += `\n⚠️ Warning: Apple Calendar sync failed. The meeting was created in Google Calendar but not synced to Apple Calendar.`;
      }

      return {
        content: [
          { type: 'text', text: `${message}\n\n${JSON.stringify(payload, null, 2)}` } as const
        ]
      };
    }
  );

  // Tool: plan_and_schedule (1-shot planner)
  server.registerTool(
    'plan_and_schedule',
    {
      title: 'Plan and schedule',
      description:
        'Finds the first contiguous slot of the requested duration within a window and books it. Attendees can be specified by name or email address - names will be automatically resolved to emails via Google Contacts.',
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        attendees: z.array(z.string()),
        durationMinutes: z.number().int().positive(),
        window: z.string().optional(),
        windowStartISO: z.string().optional(),
        windowEndISO: z.string().optional(),
        appleCalendarName: z.string().optional()
      }
      // No outputSchema
    },
    async ({
      title,
      description,
      attendees,
      durationMinutes,
      window,
      windowStartISO,
      windowEndISO,
      appleCalendarName
    }) => {
      if (window && (windowStartISO || windowEndISO)) {
        throw new Error('Cannot provide both `window` and ISO start/end times.');
      }
      if (!window && (!windowStartISO || !windowEndISO)) {
        throw new Error('Must provide either `window` or both ISO start/end times.');
      }

      let start: string, end: string;
      if (window) {
        ({ startISO: start, endISO: end } = parseDateWindow(window));
      } else {
        start = windowStartISO!;
        end = windowEndISO!;
      }

      validateISODate(start, 'windowStartISO');
      validateISODate(end, 'windowEndISO');
      validateDateRange(start, end);
      validateTimeWindow(start, end, 90); // Max 90 days for availability search
      validateDuration(durationMinutes);

      // Resolve attendees (names or emails) to email addresses
      const resolvedAttendees = await resolveAttendeesToEmails(attendees);
      const attendeeEmails = resolvedAttendees.map(a => a.email);

      const calendars = await freeBusy(start, end, attendeeEmails);
      const busyMap = googleFreeBusyToBusyMap(calendars);

      // Build slots on a small grid to find a contiguous span of durationMinutes
      const tryMinutes = Math.min(30, Math.max(5, Math.floor(durationMinutes / 6)));
      const grid = computeCommonFree({
        windowStartISO: start,
        windowEndISO: end,
        busyMaps: busyMap,
        slotMinutes: tryMinutes
      });

      const pick = pickContiguous(grid, durationMinutes);
      if (!pick) {
        return {
          content: [{ type: 'text', text: '❌ No common slot found in the window.' } as const]
        };
      }

      const result = await createMeetEvent({
        summary: title,
        description,
        startISO: pick.startISO,
        endISO: pick.endISO,
        attendees: resolvedAttendees
      });

      const appleResult = await addToAppleCalendar({
        calendarName: appleCalendarName || process.env.APPLE_CALENDAR_NAME || 'Meetings',
        title,
        notes: `Google Meet: ${result.meetUrl}\n\n${description || ''}`,
        location: result.meetUrl,
        startISO: pick.startISO,
        endISO: pick.endISO,
        attendees: resolvedAttendees
      });

      const payload = {
        scheduled: { startISO: pick.startISO, endISO: pick.endISO },
        meetUrl: result.meetUrl,
        eventHtml: result.htmlLink,
        appleCalendarSync: appleResult
      };

      let message = `✅ Scheduled "${title}" from ${pick.startISO} → ${pick.endISO}\n🔗 Meet: ${result.meetUrl}`;
      if (!appleResult.ok) {
        message += `\n⚠️ Warning: Apple Calendar sync failed. The meeting was scheduled in Google Calendar but not synced to Apple Calendar.`;
      }

      return {
        content: [
          {
            type: 'text',
            text: `${message}\n\n${JSON.stringify(payload, null, 2)}`
          } as const
        ]
      };
    }
  );

  // Tool: list_meetings
  server.registerTool(
    'list_meetings',
    {
      title: 'List upcoming meetings',
      description: 'List upcoming Google Meet meetings within a time window.',
      inputSchema: {
        windowStartISO: z.string(),
        windowEndISO: z.string(),
        maxResults: z.number().int().positive().optional()
      }
    },
    async ({ windowStartISO, windowEndISO, maxResults }) => {
      validateISODate(windowStartISO, 'windowStartISO');
      validateISODate(windowEndISO, 'windowEndISO');
      validateDateRange(windowStartISO, windowEndISO);
      validateTimeWindow(windowStartISO, windowEndISO, 365); // Max 1 year for listing

      const meetings = await listMeetings(windowStartISO, windowEndISO, maxResults ?? 50);
      const payload = { meetings };
      return {
        content: [
          {
            type: 'text',
            text: `✅ Found ${meetings.length} meeting(s).\n\n${JSON.stringify(payload, null, 2)}`
          } as const
        ]
      };
    }
  );

  // Tool: get_meeting_details
  server.registerTool(
    'get_meeting_details',
    {
      title: 'Get meeting details',
      description: 'Get detailed information about a specific meeting by event ID.',
      inputSchema: {
        eventId: z.string()
      }
    },
    async ({ eventId }) => {
      const details = await getMeetingDetails(eventId);
      const payload = { meeting: details };
      return {
        content: [
          {
            type: 'text',
            text: `✅ Meeting details:\n\n${JSON.stringify(payload, null, 2)}`
          } as const
        ]
      };
    }
  );

  // Tool: update_meeting
  server.registerTool(
    'update_meeting',
    {
      title: 'Update meeting',
      description: 'Update an existing Google Meet meeting and sync changes to Apple Calendar. Attendees can be specified by name or email address - names will be automatically resolved to emails via Google Contacts.',
      inputSchema: {
        eventId: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        startISO: z.string().optional(),
        endISO: z.string().optional(),
        attendees: z.array(z.string()).optional(),
        appleCalendarName: z.string().optional()
      }
    },
    async ({ eventId, title, description, startISO, endISO, attendees, appleCalendarName }) => {
      // Validate ISO dates if provided
      if (startISO !== undefined) validateISODate(startISO, 'startISO');
      if (endISO !== undefined) validateISODate(endISO, 'endISO');

      // Validate date range if both dates are provided
      if (startISO !== undefined && endISO !== undefined) {
        validateDateRange(startISO, endISO);
      }

      // Get original event details for Apple Calendar lookup
      const originalEvent = await getMeetingDetails(eventId);

      // Resolve attendees if provided
      let resolvedAttendees: { email: string; displayName?: string }[] | undefined;
      if (attendees !== undefined) {
        resolvedAttendees = await resolveAttendeesToEmails(attendees);
      }

      // Update Google Calendar
      const updates: {
        summary?: string;
        description?: string;
        startISO?: string;
        endISO?: string;
        attendees?: { email: string; displayName?: string }[];
      } = {};
      if (title !== undefined) updates.summary = title;
      if (description !== undefined) updates.description = description;
      if (startISO !== undefined) updates.startISO = startISO;
      if (endISO !== undefined) updates.endISO = endISO;
      if (resolvedAttendees !== undefined) updates.attendees = resolvedAttendees;

      const result = await updateMeetEvent(eventId, updates);

      // Update Apple Calendar
      const calName = appleCalendarName || process.env.APPLE_CALENDAR_NAME || 'Meetings';
      const appleUpdates: {
        title?: string;
        notes?: string;
        location?: string;
        startISO?: string;
        endISO?: string;
        attendees?: { email: string; displayName?: string }[];
      } = {};

      if (title !== undefined) appleUpdates.title = title;
      if (description !== undefined) {
        appleUpdates.notes = `Google Meet: ${result.meetUrl}\n\n${description}`;
      }
      if (result.meetUrl) appleUpdates.location = result.meetUrl;
      if (startISO !== undefined) appleUpdates.startISO = startISO;
      if (endISO !== undefined) appleUpdates.endISO = endISO;
      if (resolvedAttendees !== undefined) appleUpdates.attendees = resolvedAttendees;

      const appleResult = await updateAppleCalendarEvent({
        calendarName: calName,
        originalTitle: originalEvent.title,
        originalStartISO: originalEvent.startISO,
        updates: appleUpdates
      });

      const payload = {
        googleCalendar: { meetUrl: result.meetUrl, eventHtml: result.htmlLink },
        appleCalendar: appleResult
      };

      let message = `✅ Meeting updated.\n🔗 Meet: ${result.meetUrl}`;
      if (!appleResult.success) {
        message += `\n⚠️ Warning: ${appleResult.suggestion}`;
      }

      return {
        content: [
          {
            type: 'text',
            text: `${message}\n\n${JSON.stringify(payload, null, 2)}`
          } as const
        ]
      };
    }
  );

  // Tool: delete_meeting
  server.registerTool(
    'delete_meeting',
    {
      title: 'Delete meeting',
      description: 'Delete a Google Meet meeting and remove it from Apple Calendar.',
      inputSchema: {
        eventId: z.string(),
        appleCalendarName: z.string().optional()
      }
    },
    async ({ eventId, appleCalendarName }) => {
      // Get event details before deletion for Apple Calendar lookup
      const eventDetails = await getMeetingDetails(eventId);

      // Delete from Apple Calendar first
      const calName = appleCalendarName || process.env.APPLE_CALENDAR_NAME || 'Meetings';
      const appleResult = await deleteAppleCalendarEvent({
        calendarName: calName,
        title: eventDetails.title,
        startISO: eventDetails.startISO
      });

      // Delete from Google Calendar
      const googleResult = await deleteMeetEvent(eventId);

      const payload = {
        googleCalendar: googleResult,
        appleCalendar: appleResult
      };

      let message = `✅ Meeting deleted from Google Calendar.`;
      if (!appleResult.success) {
        message += `\n⚠️ Warning: ${appleResult.suggestion}`;
      } else {
        message += `\n✅ Meeting also deleted from Apple Calendar.`;
      }

      return {
        content: [
          {
            type: 'text',
            text: `${message}\n\n${JSON.stringify(payload, null, 2)}`
          } as const
        ]
      };
    }
  );

  // Connect (pass transport to connect, not to the constructor)
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/* ----------------------------------- CLI ---------------------------------- */
async function runCli() {
  const [cmd, ...rest] = process.argv.slice(3);

  if (cmd === 'auth') {
    await getGoogle();
    console.log('Authenticated with Google.');
    return;
  }

  if (cmd === 'search') {
    const q = rest.join(' ');
    const out = await searchInvitees(q, 10);
    console.log(out);
    return;
  }

  if (cmd === 'find') {
    const [attendeesCsv, startISO, endISO] = rest;
    const attendees = attendeesCsv.split(',').map(a => a.trim());
    const resolvedAttendees = await resolveAttendeesToEmails(attendees);
    const attendeeEmails = resolvedAttendees.map(a => a.email);
    const cals = await freeBusy(startISO, endISO, attendeeEmails);
    const busyMap = googleFreeBusyToBusyMap(cals);
    const slots = computeCommonFree({
      windowStartISO: startISO,
      windowEndISO: endISO,
      busyMaps: busyMap,
      slotMinutes: 30
    });
    console.log(slots.slice(0, 20));
    return;
  }

  if (cmd === 'create') {
    const [title, startISO, endISO, attendeesCsv] = rest;
    const attendees = attendeesCsv.split(',').map(a => a.trim());
    const resolvedAttendees = await resolveAttendeesToEmails(attendees);
    const result = await createMeetEvent({
      summary: title,
      startISO,
      endISO,
      attendees: resolvedAttendees
    });
    await addToAppleCalendar({
      calendarName: process.env.APPLE_CALENDAR_NAME || 'Meetings',
      title,
      notes: `Google Meet: ${result.meetUrl}`,
      location: result.meetUrl,
      startISO,
      endISO,
      attendees: resolvedAttendees
    });
    console.log({ meetUrl: result.meetUrl, eventHtml: result.htmlLink });
    return;
  }

  console.log(`Usage:
  pnpm cli auth
  pnpm cli search "alice"
  pnpm cli find "Alice,Bob" 2025-10-09T09:00:00Z 2025-10-09T17:00:00Z
  pnpm cli create "Design Sync" 2025-10-10T14:00:00Z 2025-10-10T14:30:00Z "Alice,bob@example.com"

  Note: Attendees can be specified by name or email address.
`);
}

/* ------------------------------- Entry Point ------------------------------ */
if (process.argv[2] === 'cli') {
  runCli().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
} else {
  startMcp().catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}