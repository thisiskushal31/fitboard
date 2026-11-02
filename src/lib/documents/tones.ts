import { Tone } from "@/generated/prisma/enums";

/** Cover letter tones, with the sign-off each one uses. */
export const TONES: Record<Tone, { label: string; description: string; signOff: string }> = {
  [Tone.WARM]: { label: "Warm", description: "Personal and upbeat.", signOff: "Warm regards," },
  [Tone.DIRECT]: { label: "Direct", description: "Short sentences, straight to the point.", signOff: "Best," },
  [Tone.FORMAL]: { label: "Formal", description: "Traditional and polished.", signOff: "Kind regards," },
};
