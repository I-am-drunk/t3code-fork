import type { VibecodeAuthStatusResult } from "@t3tools/contracts";

import { formatVibecodeCredits } from "./formatVibecodeCredits";

export interface VibecodeStatusPresentation {
  readonly label: string;
  readonly variant: "success" | "warning" | "error" | "outline" | "secondary";
}

export function getVibecodeStatusPresentation(
  status: VibecodeAuthStatusResult | null | undefined,
): VibecodeStatusPresentation {
  if (!status || status.status === "refreshing") {
    return { label: "Refreshing", variant: "outline" };
  }

  if (status.status === "missing_key") {
    return { label: "No API key configured", variant: "warning" };
  }

  if (status.status === "invalid_key") {
    return { label: "Invalid API key", variant: "error" };
  }

  if (status.status === "exhausted") {
    return { label: "Credits exhausted", variant: "error" };
  }

  if (status.status === "available") {
    if (status.credits) {
      return { label: formatVibecodeCredits(status.credits), variant: "success" };
    }
    return { label: "Credits unavailable", variant: "secondary" };
  }

  return { label: "Credits unavailable", variant: "warning" };
}
