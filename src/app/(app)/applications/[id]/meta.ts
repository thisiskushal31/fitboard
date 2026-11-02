import { formatCalendarDate, formatDate } from "@/lib/core/dates";

/** Location · work mode · salary · "Apply by " · "Created ", leaving out empty parts. */
export function metaLine(application: {
  location: string;
  mode: string;
  salary: string;
  deadline: Date | null;
  createdAt: Date;
}): string[] {
  return [
    application.location.trim(),
    application.mode.trim(),
    application.salary.trim(),
    application.deadline ? `Apply by ${formatCalendarDate(application.deadline)}` : "",
    `Created ${formatDate(application.createdAt)}`,
  ].filter(Boolean);
}
