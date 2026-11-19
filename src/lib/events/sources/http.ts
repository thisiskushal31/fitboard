import "server-only";

/** A public source answered, but not in a way Fitboard can use. */
export class SourceError extends Error {
  override name = "SourceError";
}

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 5 * 1024 * 1024;

function withTimeout(signal?: AbortSignal): { signal: AbortSignal; timeout: AbortSignal } {
  const timeout = AbortSignal.timeout(TIMEOUT_MS);
  return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, timeout };
}

/** GETs a source as text, or throws a SourceError saying why. */
export async function getText(url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<string> {
  const { signal: combined, timeout } = withTimeout(init?.signal);
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json, text/calendar, text/plain;q=0.9, text/html;q=0.8, */*;q=0.5",
        "user-agent": "Fitboard/1.0 (events search)",
        ...(init?.headers ?? {}),
      },
      redirect: "follow",
      cache: "no-store",
      signal: combined,
    });
  } catch {
    if (init?.signal?.aborted) throw new SourceError("was stopped");
    throw new SourceError(timeout.aborted ? "took too long to answer" : "couldn't be reached");
  }
  if (!response.ok) throw new SourceError(`answered with an error (${response.status})`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_BYTES) throw new SourceError("sent too much");
  let text: string;
  try {
    text = await response.text();
  } catch {
    if (init?.signal?.aborted) throw new SourceError("was stopped");
    throw new SourceError(timeout.aborted ? "took too long to answer" : "couldn't be read");
  }
  if (text.length > MAX_BYTES) throw new SourceError("sent too much");
  return text;
}

/** GETs a source as JSON, or throws a SourceError saying why. */
export async function getJson(url: string, init?: RequestInit & { signal?: AbortSignal }): Promise<unknown> {
  const text = await getText(url, {
    ...init,
    headers: { accept: "application/json", ...(init?.headers ?? {}) },
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new SourceError("didn't answer with JSON");
  }
}

/** Runs `work` over `items` in batches of `size`, collecting settled results in order. */
export async function settledInBatches<T, R>(
  items: readonly T[],
  size: number,
  work: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  const step = Math.max(1, size);
  for (let index = 0; index < items.length; index += step) {
    const slice = items.slice(index, index + step);
    out.push(...(await Promise.allSettled(slice.map(work))));
  }
  return out;
}
