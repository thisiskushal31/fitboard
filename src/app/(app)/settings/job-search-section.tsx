"use client";

import { RadioGroup } from "radix-ui";
import { useId, useState } from "react";

import { ArbeitsagenturNote } from "@/components/arbeitsagentur-note";
import { KeyField } from "@/components/key-field";
import { useTrackSave } from "@/components/save-tracker";
import { toastResult } from "@/components/toast";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { JOB_SOURCES, type JobSource, type BoardsearchHost } from "@/lib/job-search/search";
import { FREEHIRE_URL, BOARDSEARCH_KEY_URLS, SOURCE_INFO, type JobSearchSettingsView } from "@/lib/job-search/sources";
import { cn } from "@/lib/core/cn";

import { saveJobSearchDetails, saveJobSource, saveJobSourceKey, testJobSource } from "./actions";
import { SettingsSectionIntro } from "./settings-screen";

type Choice = JobSource | "OFF";

const CHOICES: readonly { value: Choice; name: string; description: string; tag: string }[] = [
  ...JOB_SOURCES.map((source) => ({ value: source, ...SOURCE_INFO[source] })),
  { value: "OFF", name: "Off", description: "Find jobs stays off, and no search leaves your server.", tag: "Nothing is sent anywhere" },
];

type Connection =
  | { status: "untested" }
  | { status: "testing" }
  | { status: "connected"; seconds: number }
  | { status: "failed"; message: string };

/**
 * Settings → Job search: which source Find jobs searches, and its
 * key. Each field saves on its own; a key is saved when you leave its field
 * and never shown again. The Bundesagentur für Arbeit is saved only once its
 * note is accepted, and isn't offered when the server turns it off.
 */
export function JobSearchSection({ initial }: { initial: JobSearchSettingsView }) {
  const track = useTrackSave();
  const [view, setView] = useState(initial);
  const [appId, setAppId] = useState(initial.adzuna.appId);
  const [connection, setConnection] = useState<Connection>({ status: "untested" });
  const source = view.source;

  // Any change means the last test no longer counts.
  const changed = () => setConnection({ status: "untested" });

  const apply = (result: Awaited<ReturnType<typeof saveJobSource>>) => {
    if (result.ok) setView(result.data);
    return result.ok;
  };

  const choose = async (next: Choice) => {
    setView((current) => ({ ...current, source: next }));
    changed();
    if (next === "ARBEITSAGENTUR" && !view.arbeitsagentur.acceptedAt) return;
    apply(toastResult(await track(saveJobSource({ source: next }))));
  };

  const acceptArbeitsagentur = async () => apply(toastResult(await track(saveJobSource({ source: "ARBEITSAGENTUR", accepted: true }))));
  const choices = view.arbeitsagentur.offered ? CHOICES : CHOICES.filter((entry) => entry.value !== "ARBEITSAGENTUR");
  // The BA can't be tested, or searched, before its note is accepted.
  const testable = source !== "ARBEITSAGENTUR" || Boolean(view.arbeitsagentur.acceptedAt);

  const chooseHost = async (host: BoardsearchHost) => {
    setView((current) => ({ ...current, boardsearch: { ...current.boardsearch, host } }));
    changed();
    apply(toastResult(await track(saveJobSearchDetails({ boardsearchHost: host }))));
  };

  const saveAppId = async () => {
    if (appId.trim() === view.adzuna.appId) return;
    changed();
    apply(toastResult(await track(saveJobSearchDetails({ adzunaAppId: appId }))));
  };

  const saveKey = async (keySource: "BOARDSEARCH" | "ADZUNA", change: { action: "set"; value: string } | { action: "clear" }) => {
    changed();
    return apply(toastResult(await track(saveJobSourceKey({ source: keySource, change }))));
  };

  const test = async () => {
    if (connection.status === "testing") return;
    setConnection({ status: "testing" });
    const result = await testJobSource({});
    if (!result.ok) setConnection({ status: "failed", message: result.error });
    else if (result.data.connected) setConnection({ status: "connected", seconds: result.data.seconds });
    else setConnection({ status: "failed", message: result.data.message });
  };

  return (
    <>
      <SettingsSectionIntro title="Job search">
        Where Find jobs looks for postings. Pick one source; you can switch any time, and each keeps its own key.
      </SettingsSectionIntro>

      <RadioGroup.Root
        aria-label="Job source"
        value={source}
        onValueChange={(value) => void choose(value as Choice)}
        className="grid grid-cols-[repeat(auto-fit,minmax(200px,1fr))] gap-3"
      >
        {choices.map((entry) => (
          <RadioGroup.Item
            key={entry.value}
            value={entry.value}
            aria-label={entry.name}
            aria-describedby={`job-source-${entry.value}`}
            className="group flex flex-col gap-1.5 rounded-card border border-line-card bg-card p-[18px] text-left hover:border-line-strong data-[state=checked]:border-primary data-[state=checked]:shadow-[0_0_0_1px_var(--color-primary)]"
          >
            <span className="flex items-center justify-between gap-2">
              <span className="text-[15px] font-medium">{entry.name}</span>
              <span
                aria-hidden
                className="grid size-4 place-items-center rounded-full border-[1.5px] border-line-strong group-data-[state=checked]:border-primary"
              >
                <RadioGroup.Indicator className="size-2 rounded-full bg-primary" />
              </span>
            </span>
            <span id={`job-source-${entry.value}`} className="flex flex-col gap-1.5">
              <span className="text-meta text-muted">{entry.description}</span>
              <span className="text-xs text-muted">{entry.tag}</span>
            </span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>

      {source !== "OFF" && (
        <>
          <p role="note" className="rounded-card bg-warning-surface px-4 py-3 text-meta text-warning">
            Your searches (keywords, place and filters) go to {SOURCE_INFO[source].name}. Nothing from your profile does.
          </p>

          <Card className="flex flex-col gap-5">
            {source === "BOARDSEARCH" && (
              <>
                <HostChoice host={view.boardsearch.host} onChange={(host) => void chooseHost(host)} />
                <KeyField
                  label="API key"
                  keyState={view.boardsearch.keyState}
                  envName="FITBOARD_BOARDSEARCH_KEY"
                  getKey={{ href: BOARDSEARCH_KEY_URLS[view.boardsearch.host], text: view.boardsearch.host === "rapidapi" ? "RapidAPI" : "OpenWeb Ninja" }}
                  onSave={(change) => saveKey("BOARDSEARCH", change)}
                />
                <p className="text-sm text-muted">
                  With a key, Find jobs and the job agent search the country you choose across APAC, JAPAC, EMEA, MEA, and the Americas. LinkedIn, Indeed and Glassdoor come through here. Monster only when Google for Jobs has the posting.
                </p>
              </>
            )}
            {source === "ADZUNA" && (
              <div className="grid grid-cols-1 gap-x-[18px] gap-y-5 sm:grid-cols-2">
                <Input
                  label="App ID"
                  value={appId}
                  spellCheck={false}
                  autoComplete="off"
                  inputClassName="font-mono text-[13.5px]"
                  onChange={(event) => setAppId(event.target.value)}
                  onBlur={() => void saveAppId()}
                />
                <KeyField
                  label="App key"
                  keyState={view.adzuna.keyState}
                  envName="FITBOARD_ADZUNA_KEY"
                  getKey={{ href: SOURCE_INFO.ADZUNA.keyUrl!, text: "Adzuna's developer site" }}
                  onSave={(change) => saveKey("ADZUNA", change)}
                />
              </div>
            )}
            {source === "ARBEITSAGENTUR" && (
              <>
                <ArbeitsagenturNote accepted={Boolean(view.arbeitsagentur.acceptedAt)} onAccept={acceptArbeitsagentur} />
                <p className="text-sm text-muted">No key needed. The job agent doesn&apos;t search this source; choose Boardsearch, Adzuna or FreeHire for it.</p>
              </>
            )}
            {source === "PUBLIC_BOARDS" && (
              <p className="text-sm text-muted">
                No key needed. The first search walks Greenhouse, Lever, Ashby, Recruitee and SmartRecruiters, plus the remote feeds, and can take a few minutes. Later searches in the same half hour use that crawl. The job agent uses this source when it is selected, and it follows the zone on the agent search: Remote, APAC, JAPAC, EMEA, MEA, Nordics, or the Americas. Employers with no public JSON API stay as links on Career path.
              </p>
            )}
            {source === "FREEHIRE" && (
              <p className="text-sm text-muted">
                {view.freehire.host === new URL(FREEHIRE_URL).host
                  ? `No key needed. Fitboard searches FreeHire's public catalogue at ${view.freehire.host}, in the country you choose across APAC, JAPAC, EMEA, MEA, and the Americas.`
                  : `No key needed. Fitboard searches your own FreeHire at ${view.freehire.host}, in the country you choose across APAC, JAPAC, EMEA, MEA, and the Americas.`}
              </p>
            )}

            {testable && (
              <div className="flex flex-wrap items-center gap-3.5 pt-1">
                <Button variant="secondary" onClick={() => void test()} disabled={connection.status === "testing"}>
                  {connection.status === "testing" ? "Testing…" : "Test connection"}
                </Button>
                <ConnectionStatus connection={connection} source={source} />
              </div>
            )}
          </Card>
        </>
      )}
    </>
  );
}

function HostChoice({ host, onChange }: { host: BoardsearchHost; onChange: (host: BoardsearchHost) => void }) {
  const labelId = useId();
  return (
    <div className="flex flex-col gap-[7px]">
      <span id={labelId} className="text-label text-muted">
        Key from
      </span>
      <SegmentedControl<BoardsearchHost>
        aria-labelledby={labelId}
        size="sm"
        options={[
          { value: "openwebninja", label: "OpenWeb Ninja" },
          { value: "rapidapi", label: "RapidAPI" },
        ]}
        value={host}
        onValueChange={onChange}
      />
    </div>
  );
}

function ConnectionStatus({ connection, source }: { connection: Connection; source: JobSource }) {
  const [dot, text, message] =
    connection.status === "connected"
      ? ["bg-success", "text-success", `Connected · ${SOURCE_INFO[source].name} answered in ${connection.seconds.toLocaleString("en-US")} s`]
      : connection.status === "failed"
        ? ["bg-error", "text-error", connection.message]
        : connection.status === "testing"
          ? ["bg-status-offer", "text-muted", "Sending a small search…"]
          : ["bg-faint", "text-muted", source === "BOARDSEARCH" ? "Not tested since your last change · a test uses one search from your plan" : "Not tested since your last change"];
  return (
    <p role="status" className={cn("flex items-center gap-2 text-control", text)}>
      <span aria-hidden className={cn("size-2 flex-none rounded-full", dot)} />
      {message}
    </p>
  );
}
