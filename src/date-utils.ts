import { startOfDay, endOfDay, startOfTomorrow, endOfTomorrow, startOfWeek, endOfWeek, addWeeks } from 'date-fns';

export function parseDateWindow(window: string): { startISO: string; endISO: string } {
  const now = new Date();
  let start: Date;
  let end: Date;

  switch (window.toLowerCase()) {
    case 'today':
      start = startOfDay(now);
      end = endOfDay(now);
      break;
    case 'tomorrow':
      start = startOfTomorrow();
      end = endOfTomorrow();
      break;
    case 'this week':
      start = startOfWeek(now, { weekStartsOn: 1 }); // Monday
      end = endOfWeek(now, { weekStartsOn: 1 });
      break;
    case 'next week':
      start = startOfWeek(addWeeks(now, 1), { weekStartsOn: 1 });
      end = endOfWeek(addWeeks(now, 1), { weekStartsOn: 1 });
      break;
    default:
      throw new Error(`Unsupported date window: ${window}`);
  }

  return {
    startISO: start.toISOString(),
    endISO: end.toISOString(),
  };
}