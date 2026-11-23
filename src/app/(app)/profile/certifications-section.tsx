"use client";

import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { useAutosave } from "@/hooks/use-autosave";
import { formatDateRange, type CertificationItem, type EntryOrder, type ProfileData } from "@/lib/profile/profile";

import { createCertification, removeCertification, reorderEntries, restoreCertification, saveCertification, sortEntriesByDate } from "./actions";
import { EntryList } from "./entry-list";
import { MonthYearField } from "./month-year-field";
import { useTrackSave } from "@/components/save-tracker";
import type { UpdateProfile } from "./skills-section";

function CertificationForm({
  entry,
  onChange,
  autoFocus,
}: {
  entry: CertificationItem;
  onChange: (entry: CertificationItem) => void;
  autoFocus: boolean;
}) {
  const track = useTrackSave();
  const { flush } = useAutosave(entry, (value) => track(saveCertification(value)));
  const set = (change: Partial<CertificationItem>) => onChange({ ...entry, ...change });

  return (
    <div className="grid grid-cols-2 gap-[18px]" onBlur={flush}>
      <Input
        className="col-span-2"
        label="Certification"
        placeholder="AWS Certified Solutions Architect"
        value={entry.name}
        onChange={(event) => set({ name: event.target.value })}
        autoFocus={autoFocus}
      />
      <Input
        className="col-span-2"
        label="Issuer"
        placeholder="Amazon Web Services"
        value={entry.issuer}
        onChange={(event) => set({ issuer: event.target.value })}
      />
      <MonthYearField
        label="Earned"
        value={{ month: entry.startMonth, year: entry.startYear }}
        onChange={({ month, year }) => set({ startMonth: month, startYear: year })}
      />
      <div className="flex flex-col gap-2.5">
        <MonthYearField
          label="Expires"
          value={{ month: entry.endMonth, year: entry.endYear }}
          onChange={({ month, year }) => set({ endMonth: month, endYear: year })}
          disabled={entry.current}
        />
        <Checkbox
          label="Still valid"
          checked={entry.current}
          onChange={(event) => set({ current: event.target.checked })}
        />
      </div>
      <Textarea
        className="col-span-2"
        label="Notes"
        placeholder="Credential ID, score, anything worth mentioning"
        rows={3}
        value={entry.notes}
        onChange={(event) => set({ notes: event.target.value })}
      />
    </div>
  );
}

/** Certifications: professional licences and certifications. Keep degrees and academic courses in Education. */
export function CertificationsSection({ profile, update, order }: { profile: ProfileData; update: UpdateProfile; order: EntryOrder }) {
  return (
    <EntryList
      items={profile.certifications}
      setItems={(change) => update((current) => ({ ...current, certifications: change(current.certifications) }))}
      addLabel="Add certification"
      ordering={{
        mode: order,
        save: (ids) => reorderEntries({ section: "certification", ids }),
        sortByDate: () => sortEntriesByDate({ section: "certification" }),
      }}
      summary={(entry) => ({
        title: entry.name.trim() || "New entry",
        subtitle: entry.issuer.trim(),
        meta: formatDateRange(entry),
      })}
      create={() => createCertification({})}
      remove={(entry) => removeCertification({ id: entry.id })}
      restore={(entry) => restoreCertification(entry)}
      renderForm={(entry, { onChange, autoFocus }) => (
        <CertificationForm entry={entry} onChange={onChange} autoFocus={autoFocus} />
      )}
    />
  );
}
