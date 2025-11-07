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

  try {
    await execFileAsync('/usr/bin/osascript', ['-e', script]);
    return { ok: true, message: 'Apple Calendar event created successfully' };
  } catch (error: any) {
    // Calendar creation might fail (e.g., AppleScript permissions, invalid calendar name)
    const errorMessage = `Failed to create Apple Calendar event: ${error.message}. The calendar "${calendarName}" may not exist or you may need to grant Calendar permissions.`;
    console.error(`❌ ${errorMessage}`);
    return {
      ok: false,
      error: errorMessage,
      suggestion: 'The Google Calendar event was created successfully, but the Apple Calendar sync failed. Check that Calendar app has necessary permissions and the calendar exists.'
    };
  }
}

function escapeApple(s: string) {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

// AppleScript needs a localized date string. Use system locale-friendly format.
// We'll output like: Thursday, 9 October 2025 14:00:00
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

// -----------------------------------------------------------------------------
// UPDATE APPLE CALENDAR EVENT
// -----------------------------------------------------------------------------
export async function updateAppleCalendarEvent({
  calendarName,
  originalTitle,
  originalStartISO,
  updates
}: {
  calendarName: string;
  originalTitle: string;
  originalStartISO: string;
  updates: {
    title?: string;
    notes?: string;
    location?: string;
    startISO?: string;
    endISO?: string;
    attendees?: { email: string; displayName?: string }[];
  };
}) {
  // AppleScript: find event by title and start date, then update properties
  const searchStartDate = appleDateString(originalStartISO);
  
  // Build property update statements
  const propertyUpdates: string[] = [];
  
  if (updates.title !== undefined) {
    propertyUpdates.push(`set summary of theEvent to "${escapeApple(updates.title)}"`);
  }
  if (updates.location !== undefined) {
    propertyUpdates.push(`set location of theEvent to "${escapeApple(updates.location)}"`);
  }
  if (updates.notes !== undefined) {
    propertyUpdates.push(`set description of theEvent to "${escapeApple(updates.notes)}"`);
  }
  if (updates.startISO !== undefined) {
    propertyUpdates.push(`set start date of theEvent to date "${appleDateString(updates.startISO)}"`);
  }
  if (updates.endISO !== undefined) {
    propertyUpdates.push(`set end date of theEvent to date "${appleDateString(updates.endISO)}"`);
  }

  const script = `
set calName to "${escapeApple(calendarName)}"
set searchTitle to "${escapeApple(originalTitle)}"
set searchStart to date "${searchStartDate}"

tell application "Calendar"
  if not (exists calendar calName) then
    error "Calendar not found: " & calName
  end if
  
  set theCal to calendar calName
  set foundEvent to false
  
  -- Search for event by title and start date
  repeat with theEvent in events of theCal
    if (summary of theEvent = searchTitle) and (start date of theEvent = searchStart) then
      set foundEvent to true
      
      -- Apply updates
      ${propertyUpdates.join('\n      ')}
      
      ${updates.attendees ? `
      -- Remove old attendees
      delete every attendee of theEvent
      
      -- Add new attendees
      ${updates.attendees.map((a) => 
        `make new attendee at theEvent with properties {email:"${escapeApple(a.email)}", display name:"${escapeApple(a.displayName || '')}"}`
      ).join('\n      ')}
      ` : ''}
      
      exit repeat
    end if
  end repeat
  
  if not foundEvent then
    error "Event not found: " & searchTitle & " at " & searchStart
  end if
end tell
`;

  try {
    await execFileAsync('/usr/bin/osascript', ['-e', script]);
    return { success: true, message: 'Apple Calendar event updated successfully' };
  } catch (error: any) {
    // Event might not exist in Apple Calendar (e.g., user deleted it manually)
    const errorMessage = `Failed to update Apple Calendar event: ${error.message}. The event may have been manually deleted or the calendar "${calendarName}" may not exist.`;
    console.error(`❌ ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
      suggestion: 'The Google Calendar event was updated successfully, but the Apple Calendar sync failed. You may need to manually update the event in Apple Calendar.'
    };
  }
}

// -----------------------------------------------------------------------------
// DELETE APPLE CALENDAR EVENT
// -----------------------------------------------------------------------------
export async function deleteAppleCalendarEvent({
  calendarName,
  title,
  startISO
}: {
  calendarName: string;
  title: string;
  startISO: string;
}) {
  // AppleScript: find event by title and start date, then delete
  const searchStartDate = appleDateString(startISO);

  const script = `
set calName to "${escapeApple(calendarName)}"
set searchTitle to "${escapeApple(title)}"
set searchStart to date "${searchStartDate}"

tell application "Calendar"
  if not (exists calendar calName) then
    error "Calendar not found: " & calName
  end if
  
  set theCal to calendar calName
  set foundEvent to false
  
  -- Search for event by title and start date
  repeat with theEvent in events of theCal
    if (summary of theEvent = searchTitle) and (start date of theEvent = searchStart) then
      delete theEvent
      set foundEvent to true
      exit repeat
    end if
  end repeat
  
  if not foundEvent then
    error "Event not found: " & searchTitle & " at " & searchStart
  end if
end tell
`;

  try {
    await execFileAsync('/usr/bin/osascript', ['-e', script]);
    return { success: true, message: 'Apple Calendar event deleted successfully' };
  } catch (error: any) {
    // Event might not exist in Apple Calendar (e.g., user deleted it manually)
    const errorMessage = `Failed to delete Apple Calendar event: ${error.message}. The event may have already been deleted or the calendar "${calendarName}" may not exist.`;
    console.error(`❌ ${errorMessage}`);
    return {
      success: false,
      error: errorMessage,
      suggestion: 'The Google Calendar event was deleted successfully, but the Apple Calendar sync failed. The event may have already been removed from Apple Calendar.'
    };
  }
}