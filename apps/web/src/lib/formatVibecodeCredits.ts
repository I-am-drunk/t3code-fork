import type { VibecodeCredits } from "@t3tools/contracts";

function formatMinorUnits(minorUnits: number, scale: number): string {
  const factor = 10 ** scale;
  const majorUnits = minorUnits / factor;
  return majorUnits.toLocaleString(undefined, {
    minimumFractionDigits: scale,
    maximumFractionDigits: scale,
  });
}

export function formatVibecodeCreditAmount(credits: VibecodeCredits): string {
  const scale = credits.minorUnitScale;
  return formatMinorUnits(credits.remainingMinorUnits, scale);
}

export function formatVibecodeCredits(credits: VibecodeCredits): string {
  const scale = credits.minorUnitScale;
  const remaining = formatMinorUnits(credits.remainingMinorUnits, scale);
  if (credits.totalMinorUnits !== undefined) {
    const total = formatMinorUnits(credits.totalMinorUnits, scale);
    return `${remaining}/${total} credits`;
  }
  return `${remaining} credits`;
}
