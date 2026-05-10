import { describe, expect, it } from "vitest";

import {
  deriveStatusFromValidation,
  normalizeLegacyCredits,
  normalizeLegacyVibecodeStatus,
  statusMessage,
} from "./vibecodeAuthDomain.ts";

describe("vibecodeAuthDomain", () => {
  it("normalizes legacy status strings", () => {
    expect(normalizeLegacyVibecodeStatus("valid")).toBe("available");
    expect(normalizeLegacyVibecodeStatus("invalid")).toBe("invalid_key");
    expect(normalizeLegacyVibecodeStatus("checking")).toBe("refreshing");
    expect(normalizeLegacyVibecodeStatus("missing")).toBe("missing_key");
  });

  it("normalizes legacy credits fields into canonical minor units", () => {
    expect(normalizeLegacyCredits({ remaining: 117, total: 500, minorUnitScale: 2 })).toEqual({
      remainingMinorUnits: 117,
      totalMinorUnits: 500,
      remaining: 117,
      total: 500,
      minorUnitScale: 2,
    });
  });

  it("derives missing key, invalid key, exhausted, available, and unknown statuses", () => {
    expect(
      deriveStatusFromValidation({
        keyPresent: false,
        authenticated: false,
        credits: undefined,
        upstreamUnavailable: false,
      }),
    ).toMatchObject({ status: "missing_key", reasonCode: "missing_key" });

    expect(
      deriveStatusFromValidation({
        keyPresent: true,
        authenticated: false,
        credits: undefined,
        upstreamUnavailable: false,
      }),
    ).toMatchObject({ status: "invalid_key", reasonCode: "invalid_key" });

    expect(
      deriveStatusFromValidation({
        keyPresent: true,
        authenticated: true,
        credits: { remainingMinorUnits: 0, minorUnitScale: 2, remaining: 0 },
        upstreamUnavailable: false,
      }),
    ).toMatchObject({ status: "exhausted", reasonCode: "credits_exhausted" });

    expect(
      deriveStatusFromValidation({
        keyPresent: true,
        authenticated: true,
        credits: { remainingMinorUnits: 1, minorUnitScale: 2, remaining: 1 },
        upstreamUnavailable: false,
      }),
    ).toMatchObject({ status: "available", reasonCode: "credits_available" });

    expect(
      deriveStatusFromValidation({
        keyPresent: true,
        authenticated: true,
        credits: undefined,
        upstreamUnavailable: true,
      }),
    ).toMatchObject({ status: "unknown", reasonCode: "upstream_unavailable" });
  });

  it("builds status-first user messages", () => {
    expect(statusMessage({ status: "missing_key", source: "none", upstreamReason: undefined })).toContain(
      "No Vibecode API key",
    );
    expect(statusMessage({ status: "exhausted", source: "stored", upstreamReason: undefined })).toContain(
      "exhausted",
    );
  });
});
