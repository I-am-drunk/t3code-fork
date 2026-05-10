import type {
  VibecodeApiKeyStatus,
  VibecodeAuthReasonCode,
  VibecodeAuthStatus,
  VibecodeCredits,
} from "@t3tools/contracts";

export const VIBECODE_CREDITS_MINOR_UNIT_SCALE = 2;

export function normalizeLegacyVibecodeStatus(
  status: string | undefined,
): VibecodeApiKeyStatus {
  switch (status) {
    case "available":
    case "missing_key":
    case "invalid_key":
    case "exhausted":
    case "unknown":
    case "refreshing":
      return status;
    case "valid":
      return "available";
    case "invalid":
      return "invalid_key";
    case "missing":
      return "missing_key";
    case "checking":
      return "refreshing";
    default:
      return "unknown";
  }
}

export function normalizeLegacyCredits(
  credits: Partial<VibecodeCredits> | undefined,
): VibecodeCredits | undefined {
  if (!credits) return undefined;
  if (credits.remainingMinorUnits !== undefined) {
    return {
      remainingMinorUnits: credits.remainingMinorUnits,
      minorUnitScale: credits.minorUnitScale ?? VIBECODE_CREDITS_MINOR_UNIT_SCALE,
      remaining: credits.remaining ?? credits.remainingMinorUnits,
      ...(credits.totalMinorUnits !== undefined
        ? {
            totalMinorUnits: credits.totalMinorUnits,
            total: credits.total ?? credits.totalMinorUnits,
          }
        : {}),
      ...(credits.resetAt ? { resetAt: credits.resetAt } : {}),
      ...(credits.label ? { label: credits.label } : {}),
    };
  }
  const remainingMinorUnits = credits.remaining;
  if (remainingMinorUnits === undefined) return undefined;
  return {
    remainingMinorUnits,
    minorUnitScale: VIBECODE_CREDITS_MINOR_UNIT_SCALE,
    remaining: remainingMinorUnits,
    ...(credits.total !== undefined ? { totalMinorUnits: credits.total, total: credits.total } : {}),
    ...(credits.resetAt ? { resetAt: credits.resetAt } : {}),
    ...(credits.label ? { label: credits.label } : {}),
  };
}

export function hasPositiveCredits(credits: VibecodeCredits | undefined): boolean {
  return (credits?.remainingMinorUnits ?? 0) > 0;
}

export function isExhaustedCredits(credits: VibecodeCredits | undefined): boolean {
  return credits !== undefined && credits.remainingMinorUnits <= 0;
}

export function deriveStatusFromValidation(input: {
  readonly keyPresent: boolean;
  readonly authenticated: boolean;
  readonly credits: VibecodeCredits | undefined;
  readonly upstreamUnavailable: boolean;
}): {
  readonly status: VibecodeAuthStatus;
  readonly reasonCode: VibecodeAuthReasonCode;
  readonly creditsKnown: boolean;
} {
  if (!input.keyPresent) {
    return {
      status: "missing_key",
      reasonCode: "missing_key",
      creditsKnown: false,
    };
  }
  if (input.upstreamUnavailable) {
    return {
      status: "unknown",
      reasonCode: "upstream_unavailable",
      creditsKnown: false,
    };
  }
  if (!input.authenticated) {
    return {
      status: "invalid_key",
      reasonCode: "invalid_key",
      creditsKnown: false,
    };
  }
  if (!input.credits) {
    return {
      status: "unknown",
      reasonCode: "credits_unknown",
      creditsKnown: false,
    };
  }
  if (isExhaustedCredits(input.credits)) {
    return {
      status: "exhausted",
      reasonCode: "credits_exhausted",
      creditsKnown: true,
    };
  }
  return {
    status: "available",
    reasonCode: "credits_available",
    creditsKnown: true,
  };
}

export function statusMessage(input: {
  readonly status: VibecodeAuthStatus;
  readonly source: "none" | "environment" | "stored";
  readonly upstreamReason: string | undefined;
}): string {
  if (input.status === "missing_key") {
    return "No Vibecode API key is configured. Add one in Settings → Providers.";
  }
  if (input.status === "invalid_key") {
    return input.upstreamReason ?? "Vibecode rejected the configured API key.";
  }
  if (input.status === "exhausted") {
    return "Your Vibecode credits are exhausted.";
  }
  if (input.status === "unknown") {
    return input.upstreamReason ?? "Unable to confirm Vibecode credits right now.";
  }
  if (input.status === "refreshing") {
    return "Refreshing Vibecode key status…";
  }
  return input.source === "environment"
    ? "Using Vibecode API key from environment configuration."
    : "Vibecode API key is ready.";
}
