import { describe, expect, it } from "vitest";

import { formatVibecodeCredits } from "./formatVibecodeCredits";
import { getVibecodeStatusPresentation } from "./vibecodeStatusPresentation";

describe("vibecode status presentation", () => {
  it("formats minor-unit credits consistently", () => {
    expect(
      formatVibecodeCredits({
        remainingMinorUnits: 117,
        totalMinorUnits: 500,
        minorUnitScale: 2,
        remaining: 117,
        total: 500,
      }),
    ).toBe("1.17/5.00 credits");
  });

  it("applies strict status-first precedence", () => {
    expect(
      getVibecodeStatusPresentation({
        status: "missing_key",
        reasonCode: "missing_key",
        authenticated: false,
        source: "none",
        keyPresent: false,
        creditsKnown: false,
        refreshing: false,
        refreshVersion: 1,
        runtimeInstanceId: "pid:1",
        checkedAt: "2026-01-01T00:00:00.000Z",
      }).label,
    ).toContain("No API key");

    expect(
      getVibecodeStatusPresentation({
        status: "available",
        reasonCode: "credits_available",
        authenticated: true,
        source: "stored",
        keyPresent: true,
        creditsKnown: true,
        credits: {
          remainingMinorUnits: 117,
          minorUnitScale: 2,
          remaining: 117,
        },
        refreshing: false,
        refreshVersion: 2,
        runtimeInstanceId: "pid:1",
        checkedAt: "2026-01-01T00:00:00.000Z",
      }).label,
    ).toBe("1.17 credits");
  });
});
