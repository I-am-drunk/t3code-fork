import type { VibecodeSettings, ServerProviderModel } from "@t3tools/contracts";
import { ProviderDriverKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { createModelCapabilities } from "@t3tools/shared/model";

import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { getVibecodeAuthStatus } from "../../vibecode/VibecodeAuthService.ts";

const PROVIDER = ProviderDriverKind.make("vibecode");
const VIBECODE_CAPABILITIES = createModelCapabilities({
  optionDescriptors: [],
});

const BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "vibecode-auto",
    name: "Vibecode Auto",
    shortName: "Auto",
    isCustom: false,
    capabilities: VIBECODE_CAPABILITIES,
  },
  {
    slug: "vibecode-pro",
    name: "Vibecode Pro",
    shortName: "Pro",
    isCustom: false,
    capabilities: VIBECODE_CAPABILITIES,
  },
];

export function buildVibecodeProviderSnapshot(
  settings: VibecodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = providerModelsFromSettings(
      BUILT_IN_MODELS,
      PROVIDER,
      settings.customModels,
      VIBECODE_CAPABILITIES,
    );

    if (!settings.enabled) {
      return buildServerProvider({
        presentation: { displayName: "Vibecode", badgeLabel: "Native" },
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Vibecode is disabled in T3 Code settings.",
        },
      });
    }

    const auth = yield* Effect.promise(() => getVibecodeAuthStatus());
    const isReady = auth.status === "valid";
    const isExhausted = auth.status === "exhausted";
    const isMissing = auth.status === "missing";
    const message =
      auth.message ??
      (isMissing ? "Add a Vibecode API key in Settings -> Providers before sending turns." : null);
    return buildServerProvider({
      presentation: { displayName: "Vibecode", badgeLabel: "Native" },
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: isReady ? "ready" : isExhausted || isMissing ? "warning" : "error",
        auth: auth.authenticated
          ? { status: "authenticated" }
          : auth.status === "missing"
            ? { status: "unknown" }
            : { status: "unauthenticated" },
        ...(message ? { message } : {}),
      },
    });
  });
}
