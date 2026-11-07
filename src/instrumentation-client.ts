import { ignoreNegativePerformanceMeasures } from "@/lib/core/dev-performance";

if (process.env.NODE_ENV === "development") ignoreNegativePerformanceMeasures();
