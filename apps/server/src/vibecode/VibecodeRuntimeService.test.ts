import { ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import {
  getVibecodePreviewStatus,
  getVibecodeRuntimeStatus,
  getVibecodeSyncStatus,
  restoreVibecodeRuntimeFromCursor,
  serializeVibecodeResumeCursor,
  upsertVibecodeRuntimeState,
} from "./VibecodeRuntimeService.ts";

describe("VibecodeRuntimeService", () => {
  it("reports ready runtime, preview, and sync state for a connected Vibecode sandbox", () => {
    const threadId = ThreadId.make("thread-vibecode-runtime");
    const turnId = TurnId.make("turn-vibecode-runtime");

    upsertVibecodeRuntimeState(threadId, {
      projectId: "project with spaces",
      projectName: "Vibecode App",
      agentUrl: "https://agent.example.com",
      previewUrl: "https://preview.example.com",
      previewSource: "sandbox_link",
      activeTurnId: turnId,
      turnStatus: "running",
      vibecodeSessionId: "session-1",
      remoteWorkspacePath: "/home/project",
    });

    const runtime = getVibecodeRuntimeStatus({ threadId });
    expect(runtime.status).toBe("running");
    expect(runtime.projectId).toBe("project with spaces");
    expect(runtime.activeTurnId).toBe(turnId);
    expect(runtime.previewUrl).toBe("https://preview.example.com");
    expect(runtime.localMirrorPath).toContain("/.t3code/vibecode/projects/project-with-spaces");

    const preview = getVibecodePreviewStatus({ threadId });
    expect(preview.status).toBe("ready");
    expect(preview.url).toBe("https://preview.example.com/");

    const sync = getVibecodeSyncStatus({ threadId });
    expect(sync.status).toBe("disabled");
    expect(sync.localPath).toContain("/.t3code/vibecode/projects/project-with-spaces");
    expect(sync.remotePath).toBe("/home/project");
  });

  it("restores safe runtime state from a resume cursor and rejects unsafe preview URLs", () => {
    const threadId = ThreadId.make("thread-vibecode-resume");

    restoreVibecodeRuntimeFromCursor(threadId, {
      vibecode: {
        version: 1,
        sessionId: "session-2",
        projectId: "project-2",
        agentUrl: "https://agent.example.com",
        previewUrl: "file:///etc/passwd",
        previewSource: "agent_done",
        model: "vibecode-pro",
      },
    });

    const runtime = getVibecodeRuntimeStatus({ threadId });
    expect(runtime.status).toBe("ready");
    expect(runtime.previewUrl).toBeUndefined();
    expect(runtime.vibecodeSessionId).toBe("session-2");

    const preview = getVibecodePreviewStatus({ threadId });
    expect(preview.status).toBe("unavailable");

    const cursor = serializeVibecodeResumeCursor(threadId);
    expect(cursor).toMatchObject({
      vibecode: {
        version: 1,
        sessionId: "session-2",
        projectId: "project-2",
        model: "vibecode-pro",
      },
    });
  });
});
