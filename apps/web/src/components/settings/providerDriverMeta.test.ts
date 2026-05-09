import { describe, expect, it } from "vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { DRIVER_OPTION_BY_VALUE, DRIVER_OPTIONS } from "./providerDriverMeta";

describe("providerDriverMeta", () => {
  it("registers Vibecode as a configurable provider driver", () => {
    const vibecode = DRIVER_OPTION_BY_VALUE[ProviderDriverKind.make("vibecode")];

    expect(DRIVER_OPTIONS.map((option) => option.value)).toContain("vibecode");
    expect(vibecode?.label).toBe("Vibecode");
    expect(Object.keys(vibecode?.settingsSchema.fields ?? {})).toEqual([
      "enabled",
      "apiBaseUrl",
      "projectId",
      "agentUrl",
      "customModels",
    ]);
  });
});
