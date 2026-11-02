import { cn } from "@/lib/core/cn";

/** A plain F, in the primary colours, so it turns light in the dark scheme. Decorative: put the name next to it. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={cn("size-8 shrink-0", className)}>
      <rect width="64" height="64" rx="10" className="fill-primary" />
      <text x="32" y="45" textAnchor="middle" className="fill-on-primary" fontFamily="Georgia, 'Times New Roman', serif" fontSize="42">
        F
      </text>
    </svg>
  );
}
