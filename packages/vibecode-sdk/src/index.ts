import type { VibecodeCredits, VibecodeProjectAccess } from "@t3tools/contracts";

const DEFAULT_BASE_URL = "https://api.vibecodeapp.com";
const REQUEST_TIMEOUT_MS = 15_000;
const CLIENT_HEADER = "vibecode-cli 0.1.0";

export interface VibecodeClientOptions {
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
}

export interface VibecodeValidationResult {
  readonly authenticated: boolean;
  readonly credits?: VibecodeCredits | undefined;
  readonly message?: string | undefined;
}

export interface VibecodeProject {
  readonly id: string;
  readonly name?: string | undefined;
  readonly platform?: string | undefined;
  readonly status?: string | undefined;
}

export interface VibecodeLink {
  readonly id: string;
  readonly port: number;
  readonly url: string;
}

export interface VibecodeSandbox {
  readonly id?: string | undefined;
  readonly projectId?: string | undefined;
  readonly status?: string | undefined;
  readonly sshPassword?: string | null | undefined;
  readonly sshUsername?: string | null | undefined;
  readonly sshPort?: number | null | undefined;
  readonly ipv4?: string | null | undefined;
  readonly ipv6?: string | null | undefined;
  readonly platform?: string | undefined;
}

export interface VibecodeSandboxAccess {
  readonly sandbox: VibecodeSandbox;
  readonly links: {
    readonly agentUrl?: VibecodeLink | undefined;
    readonly helperUrl?: VibecodeLink | undefined;
    readonly webappUrl?: VibecodeLink | undefined;
    readonly mobileUrl?: VibecodeLink | undefined;
    readonly previewUrl?: VibecodeLink | undefined;
    readonly all: ReadonlyArray<VibecodeLink>;
  };
}

export type VibecodeAgentMessage =
  | {
      readonly id?: string | undefined;
      readonly type: "init";
      readonly init: {
        readonly sessionId: string;
        readonly model: string;
        readonly tools: ReadonlyArray<string>;
        readonly workingDir: string;
      };
    }
  | { readonly id?: string | undefined; readonly type: "thinking"; readonly text: string }
  | {
      readonly id?: string | undefined;
      readonly type: "text";
      readonly subtype?: string | undefined;
      readonly text: string;
    }
  | {
      readonly id?: string | undefined;
      readonly type: "tool_use";
      readonly name?: string | undefined;
      readonly input?: Record<string, unknown> | undefined;
    }
  | {
      readonly id?: string | undefined;
      readonly type: "tool_result";
      readonly name?: string | undefined;
      readonly output?: string | undefined;
    }
  | {
      readonly id?: string | undefined;
      readonly type: "commit";
      readonly commitInfo?: { readonly checksum?: string; readonly summary?: string } | undefined;
    }
  | {
      readonly id?: string | undefined;
      readonly type: "done";
      readonly inputTokens?: number | undefined;
      readonly outputTokens?: number | undefined;
      readonly previewUrl?: string | null | undefined;
      readonly durationMs?: number | undefined;
    }
  | { readonly id?: string | undefined; readonly type: "error"; readonly error: string };

export interface VibecodeDispatchInput {
  readonly agentUrl: string;
  readonly prompt: string;
  readonly agent?: string | undefined;
  readonly model?: string | undefined;
  readonly maxTurns?: number | undefined;
  readonly sessionId?: string | undefined;
  readonly systemPrompt?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly plan?: boolean | undefined;
}

export class VibecodeApiError extends Error {
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message);
    this.name = "VibecodeApiError";
    if (status !== undefined) this.status = status;
    if (cause !== undefined) this.cause = cause;
  }
}

function normalizeBaseUrl(value: string | undefined): string {
  const trimmed = value?.trim();
  return (trimmed && trimmed.length > 0 ? trimmed : DEFAULT_BASE_URL).replace(/\/+$/u, "");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function numberFromUnknown(value: unknown): number | undefined {
  const normalize = (parsed: number, { scaled }: { readonly scaled: boolean }): number => {
    const normalized = scaled ? Math.round(parsed * 100) : Math.round(parsed);
    return Math.max(0, normalized);
  };

  if (typeof value === "number" && Number.isFinite(value)) {
    const scaled = !Number.isInteger(value);
    return normalize(value, { scaled });
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) return undefined;
    const scaled = trimmed.includes(".") || trimmed.includes(",");
    return normalize(parsed, { scaled });
  }

  return undefined;
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function messageFromErrorPayload(payload: unknown): string | undefined {
  const record = asRecord(payload);
  if (!record) return undefined;
  return (
    stringFromUnknown(record.message) ??
    stringFromUnknown(record.error) ??
    stringFromUnknown(asRecord(record.error)?.message) ??
    stringFromUnknown(record.detail)
  );
}

function findNestedRecord(record: Record<string, unknown>, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const nested = asRecord(record[key]);
    if (nested) return nested;
  }
  return record;
}

function firstString(record: Record<string, unknown>, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = stringFromUnknown(record[key]);
    if (value) return value;
  }
  return undefined;
}

function normalizeLink(value: unknown): VibecodeLink | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const url = stringFromUnknown(record.url);
  const port = numberFromUnknown(record.port);
  if (!url || port === undefined) return undefined;
  return {
    id: stringFromUnknown(record.id) ?? `${port}:${url}`,
    port,
    url,
  };
}

function normalizeLinks(value: unknown): ReadonlyArray<VibecodeLink> {
  if (Array.isArray(value)) return value.flatMap((entry) => normalizeLink(entry) ?? []);
  const record = asRecord(value);
  if (!record) return [];
  if (Array.isArray(record.links)) return normalizeLinks(record.links);
  return ["agentUrl", "helperUrl", "webappUrl", "mobileUrl", "previewUrl"].flatMap(
    (key) => normalizeLink(record[key]) ?? [],
  );
}

function linksByRole(links: ReadonlyArray<VibecodeLink>, source?: Record<string, unknown> | null) {
  const fromSource = (key: string) => normalizeLink(source?.[key]);
  const byPort = (ports: ReadonlyArray<number>) => links.find((link) => ports.includes(link.port));
  return {
    agentUrl: fromSource("agentUrl") ?? byPort([7000]),
    helperUrl: fromSource("helperUrl") ?? byPort([5000]),
    webappUrl: fromSource("webappUrl") ?? byPort([8000, 3000]),
    mobileUrl: fromSource("mobileUrl") ?? byPort([8081]),
    previewUrl: fromSource("previewUrl") ?? byPort([8000, 3000, 8081]),
    all: links,
  };
}

function normalizeProject(entry: unknown): VibecodeProject | undefined {
  const record = asRecord(entry);
  const id = stringFromUnknown(record?.id) ?? stringFromUnknown(record?.projectId);
  if (!record || !id) return undefined;
  return {
    id,
    ...(firstString(record, ["name", "title"])
      ? { name: firstString(record, ["name", "title"]) }
      : {}),
    ...(stringFromUnknown(record.platform) ? { platform: stringFromUnknown(record.platform) } : {}),
    ...(stringFromUnknown(record.status) ? { status: stringFromUnknown(record.status) } : {}),
  };
}

function normalizeSandbox(value: unknown): VibecodeSandbox {
  const record = asRecord(value) ?? {};
  return {
    ...(stringFromUnknown(record.id) ? { id: stringFromUnknown(record.id) } : {}),
    ...(stringFromUnknown(record.projectId)
      ? { projectId: stringFromUnknown(record.projectId) }
      : {}),
    ...(stringFromUnknown(record.status) ? { status: stringFromUnknown(record.status) } : {}),
    ...(record.sshPassword === null || stringFromUnknown(record.sshPassword)
      ? { sshPassword: stringFromUnknown(record.sshPassword) ?? null }
      : {}),
    ...(record.sshUsername === null || stringFromUnknown(record.sshUsername)
      ? { sshUsername: stringFromUnknown(record.sshUsername) ?? null }
      : {}),
    ...(record.sshPort === null || numberFromUnknown(record.sshPort) !== undefined
      ? { sshPort: numberFromUnknown(record.sshPort) ?? null }
      : {}),
    ...(record.ipv4 === null || stringFromUnknown(record.ipv4)
      ? { ipv4: stringFromUnknown(record.ipv4) ?? null }
      : {}),
    ...(record.ipv6 === null || stringFromUnknown(record.ipv6)
      ? { ipv6: stringFromUnknown(record.ipv6) ?? null }
      : {}),
    ...(stringFromUnknown(record.platform) ? { platform: stringFromUnknown(record.platform) } : {}),
  };
}

function parseJsonLine(line: string): VibecodeAgentMessage | undefined {
  const parsed = JSON.parse(line) as unknown;
  const record = asRecord(parsed);
  if (!record) return undefined;
  const type = stringFromUnknown(record.type);
  const id = stringFromUnknown(record.id);

  if (type === "init") {
    const init = asRecord(record.init) ?? {};
    return {
      ...(id ? { id } : {}),
      type,
      init: {
        sessionId: firstString(init, ["session_id", "sessionId"]) ?? "",
        model: stringFromUnknown(init.model) ?? "",
        tools: Array.isArray(init.tools)
          ? init.tools.flatMap((tool) => stringFromUnknown(tool) ?? [])
          : [],
        workingDir: firstString(init, ["working_dir", "workingDir"]) ?? "",
      },
    };
  }
  if (type === "thinking") {
    return { ...(id ? { id } : {}), type, text: firstString(record, ["text", "summary"]) ?? "" };
  }
  if (type === "text") {
    return {
      ...(id ? { id } : {}),
      type,
      ...(stringFromUnknown(record.subtype) ? { subtype: stringFromUnknown(record.subtype) } : {}),
      text: firstString(record, ["text", "content", "delta"]) ?? "",
    };
  }
  if (type === "tool_use") {
    const input = asRecord(record.input);
    return {
      ...(id ? { id } : {}),
      type,
      ...(stringFromUnknown(record.name) ? { name: stringFromUnknown(record.name) } : {}),
      ...(input ? { input } : {}),
    };
  }
  if (type === "tool_result") {
    return {
      ...(id ? { id } : {}),
      type,
      ...(stringFromUnknown(record.name) ? { name: stringFromUnknown(record.name) } : {}),
      ...(stringFromUnknown(record.output) ? { output: stringFromUnknown(record.output) } : {}),
    };
  }
  if (type === "commit") {
    const info = asRecord(record.commit_info) ?? asRecord(record.commitInfo);
    const checksum = info ? stringFromUnknown(info.checksum) : undefined;
    const summary = info ? stringFromUnknown(info.summary) : undefined;
    return {
      ...(id ? { id } : {}),
      type,
      ...(checksum || summary
        ? {
            commitInfo: {
              ...(checksum ? { checksum } : {}),
              ...(summary ? { summary } : {}),
            },
          }
        : {}),
    };
  }
  if (type === "done") {
    const inputTokens =
      numberFromUnknown(record.input_tokens) ?? numberFromUnknown(record.inputTokens);
    const outputTokens =
      numberFromUnknown(record.output_tokens) ?? numberFromUnknown(record.outputTokens);
    const durationMs =
      numberFromUnknown(record.duration_ms) ?? numberFromUnknown(record.durationMs);
    const previewUrl = firstString(record, ["preview_url", "previewUrl"]);
    return {
      ...(id ? { id } : {}),
      type,
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(record.preview_url === null || record.previewUrl === null
        ? { previewUrl: null }
        : previewUrl
          ? { previewUrl }
          : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  if (type === "error") {
    return {
      ...(id ? { id } : {}),
      type,
      error: firstString(record, ["error", "message"]) ?? "Vibecode agent failed.",
    };
  }
  return undefined;
}

export function parseCredits(value: unknown): VibecodeCredits | undefined {
  const root = asRecord(value);
  if (!root) return undefined;
  const creditsRecord = findNestedRecord(root, ["credits", "usage", "quota", "billing"]);
  const remaining =
    numberFromUnknown(creditsRecord.remaining) ??
    numberFromUnknown(creditsRecord.available) ??
    numberFromUnknown(creditsRecord.balance) ??
    numberFromUnknown(creditsRecord.credits) ??
    numberFromUnknown(root.creditBalance) ??
    numberFromUnknown(root.creditsRemaining);
  if (remaining === undefined) return undefined;
  const total =
    numberFromUnknown(creditsRecord.total) ??
    numberFromUnknown(creditsRecord.limit) ??
    numberFromUnknown(creditsRecord.monthly);
  const resetAt =
    stringFromUnknown(creditsRecord.resetAt) ??
    stringFromUnknown(creditsRecord.resetsAt) ??
    stringFromUnknown(creditsRecord.renewalAt);
  const label = stringFromUnknown(creditsRecord.label);
  return {
    remaining,
    ...(total !== undefined ? { total } : {}),
    ...(resetAt ? { resetAt } : {}),
    ...(label ? { label } : {}),
  };
}

export class VibecodeClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: VibecodeClientOptions = {}) {
    this.baseUrl = normalizeBaseUrl(
      options.baseUrl ?? process.env.VIBECODE_BASE_URL ?? process.env.VIBECODE_API_BASE_URL,
    );
    this.fetchImpl = options.fetch ?? fetch;
  }

  async checkVersion(): Promise<unknown> {
    return this.requestJson(null, "/v1/version", undefined, {
      channel: "stable",
      client: "vibecode-cli",
    });
  }

  async validateApiKey(apiKey: string): Promise<VibecodeValidationResult> {
    const payload = await this.requestJson(apiKey, "/v1/user");
    const record = asRecord(payload);
    const credits = parseCredits(payload);
    const authenticated =
      record?.authenticated === true ||
      record?.ok === true ||
      record?.id !== undefined ||
      record?.email !== undefined ||
      record?.firstName !== undefined ||
      record?.user !== undefined ||
      credits !== undefined;
    return {
      authenticated,
      ...(credits ? { credits } : {}),
      ...(authenticated ? {} : { message: "Vibecode did not accept the API key." }),
    };
  }

  async listProjects(
    apiKey: string,
    opts: { readonly limit?: number; readonly query?: string } = {},
  ): Promise<ReadonlyArray<VibecodeProject>> {
    const payload = await this.requestJson(apiKey, "/v1/projects", undefined, {
      ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
      ...(opts.query ? { q: opts.query } : {}),
    });
    const root = asRecord(payload);
    const candidates = Array.isArray(payload)
      ? payload
      : Array.isArray(root?.projects)
        ? root.projects
        : Array.isArray(root?.data)
          ? root.data
          : [];
    return candidates.flatMap((entry) => normalizeProject(entry) ?? []);
  }

  async getProject(apiKey: string, projectId: string): Promise<VibecodeProject> {
    const payload = await this.requestJson(apiKey, `/v1/projects/${encodeURIComponent(projectId)}`);
    const project = normalizeProject(payload);
    if (!project) throw new VibecodeApiError("Vibecode project response was invalid.");
    return project;
  }

  async checkProjectAccess(
    apiKey: string,
    projectId: string | undefined,
  ): Promise<VibecodeProjectAccess> {
    const normalizedProjectId = projectId?.trim();
    if (!normalizedProjectId) return { checked: false, allowed: true };
    try {
      await this.getProject(apiKey, normalizedProjectId);
      return { checked: true, allowed: true, projectId: normalizedProjectId };
    } catch (error) {
      return {
        checked: true,
        allowed: false,
        projectId: normalizedProjectId,
        reason: error instanceof Error ? error.message : "Unable to verify project access.",
      };
    }
  }

  async acquireSandbox(apiKey: string, projectId: string): Promise<VibecodeSandboxAccess> {
    const payload = await this.requestJson(apiKey, "/v1/sandboxes/acquire", { projectId });
    const root = asRecord(payload);
    const sandbox = normalizeSandbox(root?.sandbox ?? payload);
    const sourceLinks = asRecord(root?.links);
    const all = normalizeLinks(sourceLinks);
    return { sandbox, links: linksByRole(all, sourceLinks) };
  }

  async listSandboxLinks(apiKey: string, projectId: string): Promise<ReadonlyArray<VibecodeLink>> {
    const payload = await this.requestJson(
      apiKey,
      `/v1/sandboxes/${encodeURIComponent(projectId)}/links`,
    );
    return normalizeLinks(payload);
  }

  async createSandboxLink(apiKey: string, projectId: string, port: number): Promise<VibecodeLink> {
    const payload = await this.requestJson(
      apiKey,
      `/v1/sandboxes/${encodeURIComponent(projectId)}/links`,
      {
        port,
      },
    );
    const link = normalizeLink(payload);
    if (!link) throw new VibecodeApiError(`Vibecode did not return a link for port ${port}.`);
    return link;
  }

  async ensureSandboxAccess(apiKey: string, projectId: string): Promise<VibecodeSandboxAccess> {
    const acquired = await this.acquireSandbox(apiKey, projectId);
    const listed = await this.listSandboxLinks(apiKey, projectId).catch(() => acquired.links.all);
    const project = await this.getProject(apiKey, projectId).catch(() => undefined);
    const ports = new Set(listed.map((link) => link.port));
    const ensured = [...listed];
    for (const port of [7000, 5000, project?.platform === "mobile" ? 8081 : 8000]) {
      if (!ports.has(port)) ensured.push(await this.createSandboxLink(apiKey, projectId, port));
    }
    return {
      sandbox: acquired.sandbox,
      links: linksByRole(ensured, asRecord(acquired.links)),
    };
  }

  async *dispatchAgent(input: VibecodeDispatchInput): AsyncGenerator<VibecodeAgentMessage> {
    const url = new URL("/v1/dispatch", normalizeBaseUrl(input.agentUrl));
    url.searchParams.set("prompt", input.prompt);
    url.searchParams.set("agent", input.agent ?? "vibecode");
    url.searchParams.set("model", input.model ?? "vibecode-auto");
    url.searchParams.set("max_turns", String(input.maxTurns ?? 100));
    if (input.sessionId) url.searchParams.set("session_id", input.sessionId);
    if (input.systemPrompt) url.searchParams.set("system_prompt", input.systemPrompt);
    if (input.reasoningEffort) url.searchParams.set("reasoning_effort", input.reasoningEffort);
    if (input.plan !== undefined) url.searchParams.set("plan", String(input.plan));

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { accept: "text/event-stream" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 20),
    });
    if (!response.ok || !response.body) {
      throw new VibecodeApiError(
        `Vibecode dispatch failed with HTTP ${response.status}.`,
        response.status,
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split(/\n\n/u);
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        for (const line of frame.split(/\n/u)) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const message = parseJsonLine(trimmed.slice(5).trim());
          if (message) yield message;
        }
      }
    }
    if (buffer.trim().length > 0) {
      for (const line of buffer.split(/\n/u)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const message = parseJsonLine(trimmed.slice(5).trim());
        if (message) yield message;
      }
    }
  }

  async stopAgent(agentUrl: string): Promise<boolean> {
    const response = await this.fetchImpl(new URL("/v1/stop", normalizeBaseUrl(agentUrl)), {
      method: "POST",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const payload = (await response.json().catch(() => ({}))) as unknown;
    return asRecord(payload)?.stopped === true;
  }

  private async requestJson(
    apiKey: string | null,
    path: string,
    body?: unknown,
    query?: Record<string, string | number | undefined>,
  ): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    const response = await this.fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(apiKey
          ? { authorization: `Bearer ${apiKey}`, "x-vibecode-client": CLIENT_HEADER }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errorPayload = await response
        .json()
        .catch(async () => ({ message: await response.text().catch(() => "") }));
      const errorMessage = messageFromErrorPayload(errorPayload);
      throw new VibecodeApiError(
        errorMessage
          ? `Vibecode request failed with HTTP ${response.status}: ${errorMessage}`
          : `Vibecode request failed with HTTP ${response.status}.`,
        response.status,
      );
    }
    return await response.json();
  }
}
