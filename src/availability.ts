import { addMinutes, areIntervalsOverlapping, formatISO, parseISO } from 'date-fns';

type BusyInterval = { start: Date; end: Date };

export function computeCommonFree({
  windowStartISO,
  windowEndISO,
  busyMaps,
  slotMinutes = 30
}: {
  windowStartISO: string;
  windowEndISO: string;
  busyMaps: Record<string, BusyInterval[]>;
  slotMinutes?: number;
}) {
  const windowStart = parseISO(windowStartISO);
  const windowEnd = parseISO(windowEndISO);

  const slots: { startISO: string; endISO: string }[] = [];
  for (let t = new Date(windowStart); t < windowEnd; t = addMinutes(t, slotMinutes)) {
    const end = addMinutes(t, slotMinutes);
    const slot = { start: t, end };
    const overlaps = Object.values(busyMaps).some((busyList) =>
      busyList.some((b) => areIntervalsOverlapping(slot, b))
    );
    if (!overlaps) {
      slots.push({ startISO: formatISO(t), endISO: formatISO(end) });
    }
  }
  return slots;
}

// transform Google freeBusy response-> map
export function googleFreeBusyToBusyMap(calendars: any): Record<string, BusyInterval[]> {
  const map: Record<string, BusyInterval[]> = {};
  for (const [id, data] of Object.entries<any>(calendars)) {
    map[id] =
      data.busy?.map((b: any) => ({
        start: new Date(b.start),
        end: new Date(b.end)
      })) ?? [];
  }
  return map;
}