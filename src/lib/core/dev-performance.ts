// In development, React's Server Component profiler calls performance.measure
// with a negative or non-finite end time when redirect() or notFound() stops
// a render. The browser throws a TypeError, and the Next.js overlay shows it.
// This ignores that measurement. Browsers word the rejection differently.

function isProfilerTimestampError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.includes("negative time stamp") || error.message.includes("non-finite"))
  );
}

export function ignoreNegativePerformanceMeasures(target: Pick<Performance, "measure"> = performance) {
  const measure = target.measure.bind(target);
  target.measure = ((...args: Parameters<Performance["measure"]>) => {
    try {
      return measure(...args);
    } catch (error) {
      if (isProfilerTimestampError(error)) return;
      throw error;
    }
  }) as Performance["measure"];
}
