import * as Effect from "effect/Effect";
import { TextGenerationError } from "@t3tools/contracts";
import type { TextGenerationShape } from "./TextGeneration.ts";

const unsupported = (operation: string) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail: "Vibecode text-generation helpers are not connected yet.",
    }),
  );

export function makeVibecodeTextGeneration(): TextGenerationShape {
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
  };
}
