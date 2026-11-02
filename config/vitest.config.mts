import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { configDefaults, defineConfig } from "vitest/config";

const root = fileURLToPath(new URL("..", import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    // Resolve the `@/*` alias from tsconfig.json.
    tsconfigPaths: true,
    alias: {
      // `server-only` throws outside a React Server Components bundle, which
      // tests aren't. Next.js still enforces it in the app.
      "server-only": fileURLToPath(new URL("../src/test/empty-module.ts", import.meta.url)),
    },
  },
  test: {
    // Leave room for the dev server and database on the same machine.
    maxWorkers: "50%",
    // `yarn test:coverage`. CI fails when coverage drops below these lines.
    coverage: {
      provider: "v8",
      include: ["src/**"],
      exclude: ["src/generated/**", "src/test/**", "**/*.d.ts"],
      reporter: ["text-summary", "json-summary", "html"],
      reportsDirectory: "coverage",
      thresholds: {
        lines: 86,
        statements: 84,
        functions: 82,
        branches: 78,
        // The domain modules and the AI layer: status, dashboard, file names,
        // schemas, prompts, fact guard, encryption, sessions, rate limiting…
        "src/lib/**": { lines: 94, statements: 92, functions: 90, branches: 83 },
        "src/lib/ai/**": { lines: 94, statements: 92, functions: 92, branches: 81 },
      },
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          environment: "node",
          include: ["src/test/**/*.test.ts"],
          exclude: [...configDefaults.exclude, "**/*.db.test.ts"],
        },
      },
      {
        // Tests against a real Postgres database (see src/test/db.ts).
        extends: true,
        test: {
          name: "db",
          environment: "node",
          include: ["src/test/**/*.db.test.ts"],
          globalSetup: ["./src/test/db-global-setup.ts"],
          // The files share one database, so they run one at a time.
          fileParallelism: false,
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          environment: "jsdom",
          include: ["src/test/**/*.test.tsx"],
          setupFiles: ["./src/test/setup-dom.ts"],
        },
      },
    ],
  },
});
