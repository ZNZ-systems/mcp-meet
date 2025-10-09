import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export async function addToAppleCalendar({
  calendarName,
  title,
  notes,
  location,
  startISO,
  endISO,
  attendees
}: {
  calendarName: string;
  title: string;
  notes?: string;
  location?: string;
  startISO: string; // ISO 8601 string
  endISO: string;
  attendees: { email: string; displayName?: string }[];
}) {
  // AppleScript: create event in specified calendar and add attendees + notes (Meet link in notes)
  const script = `
set calName to "${escapeApple(calendarName)}"
set theTitle to "${escapeApple(title)}"
set theLocation to "${escapeApple(location || "")}"
set theNotes to "${escapeApple(notes || "")}"
set startDate to date "${appleDateString(startISO)}"
set endDate to date "${appleDateString(endISO)}"

tell application "Calendar"
  if not (exists calendar calName) then
    make new calendar with properties {name:calName}
  end if
  set theCal to calendar calName
  set theEvent to make new event at end of events of theCal with properties {summary:theTitle, location:theLocation, start date:startDate, end date:endDate, description:theNotes}
  
  ${attendees
    .map(
      (a) =>
        `make new attendee at theEvent with properties {email:"${escapeApple(
          a.email
        )}", display name:"${escapeApple(a.displayName || "")}"}`
    )
    .join('\n  ')}

  -- keep selected for user visibility (optional)
  show theEvent
end tell
`;
  await execFileAsync('/usr/bin/osascript', ['-e', script]);
  return { ok: true };
}

function escapeApple(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// AppleScript needs a localized date string. Use system locale-friendly format.
// We’ll output like: Thursday, 9 October 2025 14:00:00
function appleDateString(iso: string) {
  const d = new Date(iso);
  // Use toLocaleString with en-GB to be robust (24h). Adjust as needed.
  return d.toLocaleString('en-GB', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
}