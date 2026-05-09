import type { VibecodeCredits } from "@t3tools/contracts";

function formatCreditValue(value: number): string {
  if (value >= 100 && value % 100 !== 0) {
    return (value / 100).toFixed(2);
  }
  return String(value);
}

export function formatVibecodeCredits(credits: VibecodeCredits): string {
  const remaining = formatCreditValue(credits.remaining);
  if (credits.total !== undefined) {
    const total = formatCreditValue(credits.total);
    return `${remaining}/${total} credits`;
  }
  return `${remaining} credits`;
}
