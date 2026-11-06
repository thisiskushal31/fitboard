import type { Metadata } from "next";

import { EMPTY_CAREER_ROLES, type CareerRoles } from "@/lib/career/career";
import { prisma } from "@/lib/core/prisma";
import { catalogCareers } from "@/lib/job-search/board-crawl";

import { CareerScreen } from "./career-screen";

export const metadata: Metadata = { title: "Career path" };

/** The public-board crawl can take a few minutes. */
export const maxDuration = 300;

const CAREER_KEY = "fitboardCareer";

export default async function CareerPage() {
  const [row, skills] = await Promise.all([
    prisma.setting.findUnique({ where: { key: CAREER_KEY } }),
    prisma.skill.count(),
  ]);
  return <CareerScreen roles={readRoles(row?.value)} skillCount={skills} links={catalogCareers()} />;
}

function readRoles(value: string | undefined): CareerRoles {
  if (!value) return EMPTY_CAREER_ROLES;
  try {
    const parsed = JSON.parse(value) as Partial<CareerRoles>;
    return {
      current: parsed.current ?? [],
      next: parsed.next ?? [],
      destination: parsed.destination ?? [],
      trending: parsed.trending ?? [],
    };
  } catch {
    return EMPTY_CAREER_ROLES;
  }
}
