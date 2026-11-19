/** Shared iCalendar (ICS) parsing for Meetup and other public calendar feeds. */

export type IcsEvent = {
  uid: string;
  summary: string;
  description: string;
  location: string;
  url: string;
  startsAt: string | null;
  endsAt: string | null;
};

function unfold(ics: string): string {
  return ics.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
}

function unescape(value: string): string {
  return value
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\")
    .trim();
}

function field(block: string, name: string): string {
  const match = block.match(new RegExp(`(?:^|\\n)${name}(?:;[^:\\n]*)?:([^\\n]*)`, "i"));
  return match ? unescape(match[1] ?? "") : "";
}

/** Parse `YYYYMMDD` or `YYYYMMDDTHHMMSSZ` into an ISO instant. */
export function icsDateToIso(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  const day = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (day) return `${day[1]}-${day[2]}-${day[3]}T00:00:00.000Z`;
  const stamp = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z?$/i);
  if (stamp) return `${stamp[1]}-${stamp[2]}-${stamp[3]}T${stamp[4]}:${stamp[5]}:${stamp[6]}.000Z`;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/** Pulls VEVENT blocks from an ICS document. Bad blocks are skipped. */
export function eventsFromIcs(ics: string): IcsEvent[] {
  if (!ics || !/BEGIN:VEVENT/i.test(ics)) return [];
  const text = unfold(ics);
  const blocks = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) ?? [];
  const events: IcsEvent[] = [];
  for (const block of blocks) {
    try {
      const summary = field(block, "SUMMARY");
      const uid = field(block, "UID") || field(block, "URL") || summary;
      if (!summary && !uid) continue;
      events.push({
        uid,
        summary,
        description: field(block, "DESCRIPTION"),
        location: field(block, "LOCATION"),
        url: field(block, "URL"),
        startsAt: icsDateToIso(field(block, "DTSTART")),
        endsAt: icsDateToIso(field(block, "DTEND")),
      });
    } catch {
      /* skip malformed VEVENT */
    }
  }
  return events;
}
