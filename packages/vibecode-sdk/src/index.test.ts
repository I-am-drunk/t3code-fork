import { describe, expect, it } from "vitest";

import { parseCredits, VibecodeClient } from "./index.ts";

const fetchProjectListMock = async () =>
  new Response(
    JSON.stringify({
      data: [{ id: "project-a", name: "Project A" }, { projectId: "project-b" }],
    }),
    { status: 200 },
  );

describe("parseCredits", () => {
  it("reads common nested credit shapes", () => {
    expect(
      parseCredits({
        usage: {
          remaining: "42",
          total: 100,
          resetAt: "2026-06-01T00:00:00.000Z",
        },
      }),
    ).toEqual({
      remaining: 42,
      total: 100,
      resetAt: "2026-06-01T00:00:00.000Z",
    });
  });

  it("reads the installed CLI user creditBalance shape", () => {
    expect(
      parseCredits({
        firstName: "TJ",
        planTier: "pro",
        creditBalance: 321,
      }),
    ).toEqual({ remaining: 321 });
  });
});

describe("VibecodeClient", () => {
  it("uses the real CLI q query parameter for project search", async () => {
    const requests: Array<string> = [];
    const client = new VibecodeClient({
      baseUrl: "https://vibecode.test",
      fetch: (async (input) => {
        requests.push(String(input));
        return fetchProjectListMock();
      }) as typeof fetch,
    });

    await expect(client.listProjects("key", { limit: 7, query: "captured" })).resolves.toEqual([
      { id: "project-a", name: "Project A" },
      { id: "project-b" },
    ]);
    expect(requests[0]).toBe("https://vibecode.test/v1/projects?limit=7&q=captured");
  });

  it("normalizes acquired sandbox links and creates missing preview ports", async () => {
    const requests: Array<{ url: string; body?: unknown }> = [];
    const client = new VibecodeClient({
      baseUrl: "https://vibecode.test",
      fetch: (async (input, init) => {
        requests.push({
          url: String(input),
          ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
        });
        const url = new URL(String(input));
        if (url.pathname === "/v1/sandboxes/acquire") {
          return new Response(
            JSON.stringify({
              sandbox: { id: "sbx_1", projectId: "abc123", status: "running" },
              links: {
                agentUrl: { id: "agent", port: 7000, url: "https://agent.test" },
              },
            }),
            { status: 200 },
          );
        }
        if (url.pathname === "/v1/sandboxes/abc123/links" && init?.method !== "POST") {
          return new Response(
            JSON.stringify({ links: [{ id: "agent", port: 7000, url: "https://agent.test" }] }),
            { status: 200 },
          );
        }
        if (url.pathname === "/v1/projects/abc123") {
          return new Response(JSON.stringify({ id: "abc123", platform: "webapp" }), {
            status: 200,
          });
        }
        return new Response(
          JSON.stringify({
            id: `link-${(JSON.parse(String(init?.body)) as { port: number }).port}`,
            port: (JSON.parse(String(init?.body)) as { port: number }).port,
            url: `https://port-${(JSON.parse(String(init?.body)) as { port: number }).port}.test`,
          }),
          { status: 200 },
        );
      }) as typeof fetch,
    });

    await expect(client.ensureSandboxAccess("key", "abc123")).resolves.toMatchObject({
      links: {
        agentUrl: { port: 7000, url: "https://agent.test" },
        helperUrl: { port: 5000 },
        previewUrl: { port: 8000 },
      },
    });
    expect(requests.map((request) => request.body).filter(Boolean)).toContainEqual({ port: 8000 });
  });

  it("dispatches agent turns using the installed CLI GET SSE contract", async () => {
    const requests: Array<{
      url: string;
      method: string | undefined;
      authorization: string | undefined;
    }> = [];
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              'data: {"id":"m1","type":"init","init":{"session_id":"sess_1","model":"vibecode-pro","working_dir":"/home/user/workspace","tools":["Read"]}}',
              "",
              'data: {"id":"m2","type":"text","subtype":"delta","text":"hello"}',
              "",
              'data: {"id":"m3","type":"done","input_tokens":1,"output_tokens":2,"preview_url":"https://preview.test"}',
              "",
            ].join("\n"),
          ),
        );
        controller.close();
      },
    });
    const client = new VibecodeClient({
      fetch: (async (input, init) => {
        requests.push({
          url: String(input),
          method: init?.method,
          authorization: new Headers(init?.headers).get("authorization") ?? undefined,
        });
        return new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }) as typeof fetch,
    });

    const messages = [];
    for await (const message of client.dispatchAgent({
      agentUrl: "https://agent.test",
      prompt: "Build",
      model: "vibecode-pro",
      agent: "vibecode",
      maxTurns: 3,
      reasoningEffort: "high",
      plan: true,
    })) {
      messages.push(message);
    }

    expect(requests[0]).toMatchObject({ method: "GET", authorization: undefined });
    expect(requests[0]?.url).toBe(
      "https://agent.test/v1/dispatch?prompt=Build&agent=vibecode&model=vibecode-pro&max_turns=3&reasoning_effort=high&plan=true",
    );
    expect(messages).toEqual([
      {
        id: "m1",
        type: "init",
        init: {
          sessionId: "sess_1",
          model: "vibecode-pro",
          workingDir: "/home/user/workspace",
          tools: ["Read"],
        },
      },
      { id: "m2", type: "text", subtype: "delta", text: "hello" },
      {
        id: "m3",
        type: "done",
        inputTokens: 1,
        outputTokens: 2,
        previewUrl: "https://preview.test",
      },
    ]);
  });
});
