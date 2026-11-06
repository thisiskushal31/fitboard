"use client";

import { useState } from "react";

import { PageHeader } from "@/components/page-header";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import type { CareerReport, CareerRoles } from "@/lib/career/career";

import { saveCareer, scanCareer } from "./actions";

type CareerLink = { name: string; url: string; sector: string };

function groupsOf(links: CareerLink[]) {
  const groups = new Map<string, CareerLink[]>();
  for (const link of links) {
    const list = groups.get(link.sector);
    if (list) list.push(link);
    else groups.set(link.sector, [link]);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

const join = (roles: string[]) => roles.join("\n");

export function CareerScreen({ roles, skillCount, links }: { roles: CareerRoles; skillCount: number; links: CareerLink[] }) {
  const [current, setCurrent] = useState(join(roles.current));
  const [next, setNext] = useState(join(roles.next));
  const [destination, setDestination] = useState(join(roles.destination));
  const [trending, setTrending] = useState(join(roles.trending));
  const [report, setReport] = useState<CareerReport | null>(null);
  const [pending, setPending] = useState<"save" | "scan" | null>(null);

  const save = async () => {
    setPending("save");
    const result = await saveCareer({ current, next, destination, trending });
    toastResult(result);
    setPending(null);
  };

  const scan = async () => {
    setPending("scan");
    const result = await scanCareer({});
    if (result.ok) setReport(result.data);
    toastResult(result);
    setPending(null);
  };

  const groups = groupsOf(links);

  return (
    <>
      <PageHeader
        title="Career path"
        description="Current, next, destination, and trending titles. A crawl says which skills those listings asked for that the profile does not have. Those skills stay off the resume until you have them."
      />
      <div className="mx-auto flex w-full max-w-[760px] flex-col gap-6 px-10 pb-16">
        <Card className="flex flex-col gap-4">
          <Textarea label="Current roles" hint="One title per line." value={current} onChange={(event) => setCurrent(event.target.value)} rows={4} />
          <Textarea label="Next roles" value={next} onChange={(event) => setNext(event.target.value)} rows={3} />
          <Textarea label="Destination roles" value={destination} onChange={(event) => setDestination(event.target.value)} rows={3} />
          <Textarea label="Trending" value={trending} onChange={(event) => setTrending(event.target.value)} rows={2} />
          <p className="text-sm text-muted">The profile has {skillCount} skill{skillCount === 1 ? "" : "s"}. Edit them on Profile. This screen starts from the demo profile, not from a YAML file.</p>
          <div className="flex flex-wrap gap-3">
            <Button onClick={() => void save()} disabled={pending !== null}>
              {pending === "save" ? "Saving…" : "Save titles"}
            </Button>
            <Button variant="secondary" onClick={() => void scan()} disabled={pending !== null}>
              {pending === "scan" ? "Reading the boards…" : "Read the boards"}
            </Button>
          </div>
        </Card>

        {report && (
          <div className="flex flex-col gap-4">
            {report.roles.map((role) => (
              <Card key={`${role.kind}-${role.name}`} className="flex flex-col gap-2">
                <p className="font-medium">
                  {role.name} <span className="text-muted">· {role.kind}</span>
                </p>
                <p className="text-sm">{role.closeness}</p>
                <p className="text-sm text-muted">
                  {role.layers.join(", ")} · {role.listingCount} listings
                </p>
                <p className="text-sm">Do next: {role.nextMove}</p>
                {role.have.length > 0 && <p className="text-sm">Keep hot: {role.have.join(", ")}</p>}
                {role.lacking.length > 0 && <p className="text-sm">Add, do not invent on the resume: {role.lacking.join(", ")}</p>}
              </Card>
            ))}
            {report.roles.length === 0 && <p className="text-sm text-muted">Save at least one title, then read the boards again.</p>}
            {report.checks.length > 0 && (
              <Card>
                <p className="font-medium">Checks this crawl</p>
                <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm">
                  {report.checks.map((gap) => (
                    <li key={gap.skill}>
                      {gap.skill} · {gap.mentions} listing{gap.mentions === 1 ? "" : "s"}
                    </li>
                  ))}
                </ul>
              </Card>
            )}
          </div>
        )}

        <Card>
          <p className="font-medium">Companies by sector</p>
          <p className="mt-1 text-sm text-muted">Sectors come from the company list. Open a page in the browser. Fitboard does not log in to it.</p>
          <div className="mt-3 flex flex-col">
            {groups.map(([sector, items]) => (
              <details key={sector} className="border-b border-line py-2 last:border-b-0">
                <summary className="cursor-pointer font-medium">
                  {sector} <span className="text-muted">{items.length}</span>
                </summary>
                <ul className="mt-2 flex flex-col gap-1 pl-1 text-sm">
                  {items.map((link) => (
                    <li key={`${link.name}\n${link.url}`}>
                      <a href={link.url} target="_blank" rel="noopener noreferrer" className="underline">
                        {link.name}
                      </a>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
        </Card>
      </div>
    </>
  );
}
