import { ProviderDriverKind, type ServerProvider, VibecodeSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeVibecodeTextGeneration } from "../../textGeneration/VibecodeTextGeneration.ts";
import { makeVibecodeAdapter } from "../Layers/VibecodeAdapter.ts";
import { buildVibecodeProviderSnapshot } from "../Layers/VibecodeProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { ProviderDriverError } from "../Errors.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";

const decodeVibecodeSettings = Schema.decodeSync(VibecodeSettings);
const DRIVER_KIND = ProviderDriverKind.make("vibecode");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
    readonly continuationGroupKey: string;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
    continuation: { groupKey: input.continuationGroupKey },
  });

export const VibecodeDriver: ProviderDriver<VibecodeSettings> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Vibecode",
    supportsMultipleInstances: true,
  },
  configSchema: VibecodeSettings,
  defaultConfig: (): VibecodeSettings => decodeVibecodeSettings({}),
  create: ({ instanceId, displayName, accentColor, enabled, config }) =>
    Effect.gen(function* () {
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies VibecodeSettings;
      const snapshot = yield* makeManagedServerProvider<VibecodeSettings>({
        maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          buildVibecodeProviderSnapshot(settings).pipe(Effect.map(stampIdentity)),
        checkProvider: buildVibecodeProviderSnapshot(effectiveConfig).pipe(
          Effect.map(stampIdentity),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Vibecode snapshot: ${cause.message}`,
              cause,
            }),
        ),
      );
      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter: makeVibecodeAdapter({ instanceId, settings: effectiveConfig }),
        textGeneration: makeVibecodeTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
