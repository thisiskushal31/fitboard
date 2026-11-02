// Prisma reads this file from the project root. The production image copies it
// to /tools/prisma.config.ts, beside the prisma folder.
import "dotenv/config";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "prisma/config";

const prismaDir = join(dirname(fileURLToPath(import.meta.url)), "prisma");

export default defineConfig({
  schema: join(prismaDir, "schema.prisma"),
  migrations: {
    path: join(prismaDir, "migrations"),
    // `prisma db seed` (pass `-- --demo` for sample data); see prisma/seed.ts.
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
