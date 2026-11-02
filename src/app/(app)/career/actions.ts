"use server";

import { z } from "zod";

import { buildCareerReport, linesToRoles, type CareerReport, type CareerRoles } from "@/lib/career/career";
import { action } from "@/lib/core/action";
import { prisma } from "@/lib/core/prisma";
import { crawlPublicBoards } from "@/lib/job-search/board-crawl";

const CAREER_KEY = "fitboardCareer";

const rolesInput = z.object({
  current: z.string().max(2000),
  next: z.string().max(2000),
  destination: z.string().max(2000),
  trending: z.string().max(2000),
});

async function readRoles(): Promise<CareerRoles> {
  const row = await prisma.setting.findUnique({ where: { key: CAREER_KEY } });
  if (!row) return { current: [], next: [], destination: [], trending: [] };
  try {
    const parsed = JSON.parse(row.value) as Partial<CareerRoles>;
    return {
      current: parsed.current ?? [],
      next: parsed.next ?? [],
      destination: parsed.destination ?? [],
      trending: parsed.trending ?? [],
    };
  } catch {
    return { current: [], next: [], destination: [], trending: [] };
  }
}

async function writeRoles(roles: CareerRoles): Promise<void> {
  const value = JSON.stringify(roles);
  await prisma.setting.upsert({
    where: { key: CAREER_KEY },
    create: { key: CAREER_KEY, value },
    update: { value },
  });
}

/** Saves the career-path titles. They live in the database, not in a YAML file. */
export const saveCareer = action(rolesInput, async (input, { toast }) => {
  const roles = linesToRoles(input.current, input.next, input.destination, input.trending);
  await writeRoles(roles);
  toast("Career path saved.");
  return roles;
});

/** Reads the public boards and reports skill gaps for the saved titles. */
export const scanCareer = action(z.object({}), async (_input, { toast }): Promise<CareerReport> => {
  const [roles, skills] = await Promise.all([readRoles(), prisma.skill.findMany({ select: { name: true } })]);
  const postings = await crawlPublicBoards("software engineer");
  toast("Career path updated from this crawl.");
  return buildCareerReport(
    postings,
    skills.map((skill) => skill.name),
    roles,
  );
});
