/** Shared RSS item parsing for public freelance feeds. */

export type RssItem = {
  title: string;
  link: string;
  description: string;
  pubDate: string;
};

function decode(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pulls `<item>` blocks from an RSS/Atom-ish XML document. Bad blocks are skipped. */
export function itemsFromRss(xml: string): RssItem[] {
  if (!xml || !/<item[\s>]/i.test(xml)) return [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) ?? [];
  const items: RssItem[] = [];
  for (const block of blocks) {
    try {
      const tag = (name: string) => decode(block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))?.[1] ?? "");
      const title = tag("title");
      const link = tag("link") || decode(block.match(/<link[^>]+href=["']([^"']+)["']/i)?.[1] ?? "");
      if (!title && !link) continue;
      items.push({ title, link, description: tag("description") || tag("content:encoded") || tag("summary"), pubDate: tag("pubDate") || tag("published") || tag("updated") });
    } catch {
      /* skip malformed item */
    }
  }
  return items;
}

export function postedIso(pubDate: string): string | null {
  if (!pubDate) return null;
  const posted = new Date(pubDate);
  return Number.isNaN(posted.getTime()) ? null : posted.toISOString();
}
