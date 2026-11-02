import { buildExport, exportFileName } from "@/lib/upkeep/data-export";
import { contentDisposition } from "@/lib/core/file-name";
import { prisma } from "@/lib/core/prisma";
import { route } from "@/lib/core/route";

/**
 * Downloads everything as one JSON file, with the API key
 * in plain text only for `?apiKey=1`.
 */
export const GET = route(async (request) => {
  const now = new Date();
  const data = await buildExport(prisma, { includeApiKey: request.nextUrl.searchParams.get("apiKey") === "1", now });
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": contentDisposition(exportFileName(now)),
    },
  });
});
