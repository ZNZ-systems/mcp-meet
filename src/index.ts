import 'dotenv/config';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import { getGoogle, searchInvitees, freeBusy, createMeetEvent } from './google.js';
import { addToAppleCalendar } from './apple.js';
import { computeCommonFree, googleFreeBusyToBusyMap } from './availability.js';

/* ---------------------------------- Utils --------------------------------- */
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
    version: '0.2.0'
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
      description: 'Compute shared availability across attendees using Google freeBusy.',
      inputSchema: {
        attendees: z.array(z.string().email()),
        windowStartISO: z.string(),
        windowEndISO: z.string(),
        slotMinutes: z.number().int().positive().optional()
      }
      // No outputSchema
    },
    async ({ attendees, windowStartISO, windowEndISO, slotMinutes }) => {
      const calendars = await freeBusy(windowStartISO, windowEndISO, attendees);
      const busyMap = googleFreeBusyToBusyMap(calendars);
      const slots = computeCommonFree({
        windowStartISO,
        windowEndISO,
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
        'Creates a Google Calendar event with a Meet link and mirrors it to Apple Calendar.',
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        startISO: z.string(),
        endISO: z.string(),
        attendees: z.array(
          z.object({
            email: z.string().email(),
            displayName: z.string().optional()
          })
        ),
        appleCalendarName: z.string().optional()
      }
      // No outputSchema
    },
    async ({ title, description, startISO, endISO, attendees, appleCalendarName }) => {
      const result = await createMeetEvent({
        summary: title,
        description,
        startISO,
        endISO,
        attendees
      });

      await addToAppleCalendar({
        calendarName: appleCalendarName || process.env.APPLE_CALENDAR_NAME || 'Meetings',
        title,
        notes: `Google Meet: ${result.meetUrl}\n\n${description || ''}`,
        location: result.meetUrl,
        startISO,
        endISO,
        attendees
      });

      const payload = { meetUrl: result.meetUrl, eventHtml: result.htmlLink };
      return {
        content: [
          { type: 'text', text: `✅ Meeting created.\n🔗 Meet: ${result.meetUrl}\n\n${JSON.stringify(payload, null, 2)}` } as const
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
        'Finds the first contiguous slot of the requested duration within a window and books it.',
      inputSchema: {
        title: z.string(),
        description: z.string().optional(),
        attendees: z.array(z.string().email()),
        durationMinutes: z.number().int().positive(),
        windowStartISO: z.string(),
        windowEndISO: z.string(),
        appleCalendarName: z.string().optional()
      }
      // No outputSchema
    },
    async ({
      title,
      description,
      attendees,
      durationMinutes,
      windowStartISO,
      windowEndISO,
      appleCalendarName
    }) => {
      const calendars = await freeBusy(windowStartISO, windowEndISO, attendees);
      const busyMap = googleFreeBusyToBusyMap(calendars);

      // Build slots on a small grid to find a contiguous span of durationMinutes
      const tryMinutes = Math.min(30, Math.max(5, Math.floor(durationMinutes / 6)));
      const grid = computeCommonFree({
        windowStartISO,
        windowEndISO,
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
        attendees: attendees.map((e) => ({ email: e }))
      });

      await addToAppleCalendar({
        calendarName: appleCalendarName || process.env.APPLE_CALENDAR_NAME || 'Meetings',
        title,
        notes: `Google Meet: ${result.meetUrl}\n\n${description || ''}`,
        location: result.meetUrl,
        startISO: pick.startISO,
        endISO: pick.endISO,
        attendees: attendees.map((e) => ({ email: e }))
      });

      const payload = {
        scheduled: { startISO: pick.startISO, endISO: pick.endISO },
        meetUrl: result.meetUrl,
        eventHtml: result.htmlLink
      };
      return {
        content: [
          {
            type: 'text',
            text: `✅ Scheduled "${title}" from ${pick.startISO} → ${pick.endISO}\n🔗 Meet: ${result.meetUrl}\n\n${JSON.stringify(payload, null, 2)}`
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
    const attendees = attendeesCsv.split(',');
    const cals = await freeBusy(startISO, endISO, attendees);
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
    const attendees = attendeesCsv.split(',').map((e) => ({ email: e }));
    const result = await createMeetEvent({
      summary: title,
      startISO,
      endISO,
      attendees
    });
    await addToAppleCalendar({
      calendarName: process.env.APPLE_CALENDAR_NAME || 'Meetings',
      title,
      notes: `Google Meet: ${result.meetUrl}`,
      location: result.meetUrl,
      startISO,
      endISO,
      attendees
    });
    console.log({ meetUrl: result.meetUrl, eventHtml: result.htmlLink });
    return;
  }

  console.log(`Usage:
  pnpm cli auth
  pnpm cli search "alice"
  pnpm cli find "a@x.com,b@y.com" 2025-10-09T09:00:00Z 2025-10-09T17:00:00Z
  pnpm cli create "Design Sync" 2025-10-10T14:00:00Z 2025-10-10T14:30:00Z "a@x.com,b@y.com"
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