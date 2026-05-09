import {
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type ResolvedKeybindingsConfig,
  type ThreadId,
  type VibecodeAuthStatusResult,
  type VibecodePreviewStatus,
  type VibecodeRuntimeStatus,
  type VibecodeSyncStatus,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime";
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { DiffIcon, EyeIcon, TerminalSquareIcon, ZapIcon } from "lucide-react";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, { type NewProjectScriptInput } from "../ProjectScriptsControl";
import { Toggle } from "../ui/toggle";
import { SidebarTrigger } from "../ui/sidebar";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../environments/primary";
import { formatVibecodeCredits } from "../../lib/formatVibecodeCredits";

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  activeProjectName: string | undefined;
  isGitRepo: boolean;
  openInCwd: string | null;
  activeProjectScripts: ProjectScript[] | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalToggleShortcutLabel: string | null;
  diffToggleShortcutLabel: string | null;
  gitCwd: string | null;
  diffOpen: boolean;
  vibecodeSelected: boolean;
  vibecodeAuthStatus?: VibecodeAuthStatusResult | null;
  vibecodeRuntimeStatus?: VibecodeRuntimeStatus | null;
  vibecodePreviewStatus?: VibecodePreviewStatus | null;
  vibecodeSyncStatus?: VibecodeSyncStatus | null;
  onRunProjectScript: (script: ProjectScript) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<void>;
  onUpdateProjectScript: (scriptId: string, input: NewProjectScriptInput) => Promise<void>;
  onDeleteProjectScript: (scriptId: string) => Promise<void>;
  onToggleTerminal: () => void;
  onToggleDiff: () => void;
  onOpenPreview: () => void;
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  activeProjectName,
  isGitRepo,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  terminalAvailable,
  terminalOpen,
  terminalToggleShortcutLabel,
  diffToggleShortcutLabel,
  gitCwd,
  diffOpen,
  vibecodeSelected,
  vibecodeAuthStatus,
  vibecodeRuntimeStatus,
  vibecodePreviewStatus,
  vibecodeSyncStatus,
  onRunProjectScript,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
  onToggleTerminal,
  onToggleDiff,
  onOpenPreview,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const vibecodeCredits = vibecodeAuthStatus?.credits;
  const activeVibecodeKey = vibecodeAuthStatus?.keyPool?.keys.find((key) => key.active) ?? null;
  const vibecodeNeedsKey =
    vibecodeAuthStatus?.status === "missing" ||
    vibecodeAuthStatus?.status === "invalid" ||
    vibecodeAuthStatus?.status === "exhausted";
  const vibecodeBadgeVariant =
    vibecodeAuthStatus?.status === "invalid" || vibecodeAuthStatus?.status === "exhausted"
      ? "destructive"
      : vibecodeCredits && vibecodeCredits.remaining <= 10
        ? "secondary"
        : "outline";
  const vibecodeBadgeText = vibecodeNeedsKey
    ? "Key needed"
    : vibecodeCredits
      ? formatVibecodeCredits(vibecodeCredits)
      : "Checking";
  const vibecodeBadgeTitle = [
    activeVibecodeKey
      ? `${activeVibecodeKey.label} (${activeVibecodeKey.redacted})`
      : "Vibecode key status",
    vibecodeCredits ? `${formatVibecodeCredits(vibecodeCredits)} remaining` : undefined,
    vibecodeAuthStatus?.keyPool
      ? `${vibecodeAuthStatus.keyPool.healthyCount} healthy, ${vibecodeAuthStatus.keyPool.exhaustedCount} exhausted, ${vibecodeAuthStatus.keyPool.invalidCount} invalid`
      : undefined,
    vibecodeAuthStatus?.message,
  ]
    .filter(Boolean)
    .join(" - ");
  const vibecodePreviewReady =
    vibecodePreviewStatus?.status === "ready" && vibecodePreviewStatus.url;
  const vibecodeRuntimeBadgeVariant =
    vibecodeRuntimeStatus?.status === "failed"
      ? "error"
      : vibecodeRuntimeStatus?.status === "blocked"
        ? "warning"
        : vibecodeRuntimeStatus?.status === "running"
          ? "success"
          : "outline";
  const vibecodeRuntimeBadgeText =
    vibecodeRuntimeStatus?.status === "running"
      ? "Running"
      : vibecodePreviewReady
        ? "Preview"
        : vibecodeRuntimeStatus?.status === "ready"
          ? "Ready"
          : vibecodeRuntimeStatus?.status === "failed"
            ? "Failed"
            : "Runtime";
  const vibecodeRuntimeBadgeTitle = [
    vibecodeRuntimeStatus?.message,
    vibecodeRuntimeStatus?.projectName ?? vibecodeRuntimeStatus?.projectId,
    vibecodeRuntimeStatus?.agentUrl,
    vibecodePreviewStatus?.url,
    vibecodeSyncStatus?.message,
  ]
    .filter(Boolean)
    .join(" - ");
  const vibecodePreviewTooltip = vibecodePreviewReady
    ? `Open Vibecode preview: ${vibecodePreviewStatus.url}`
    : (vibecodePreviewStatus?.message ??
      "Preview is available after Vibecode returns a sandbox URL.");

  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        <SidebarTrigger className="size-7 shrink-0 md:hidden" />
        <h2
          className="min-w-0 shrink truncate text-sm font-medium text-foreground"
          title={activeThreadTitle}
        >
          {activeThreadTitle}
        </h2>
        {activeProjectName && (
          <Badge variant="outline" className="min-w-0 shrink overflow-hidden">
            <span className="min-w-0 truncate">{activeProjectName}</span>
          </Badge>
        )}
        {activeProjectName && !isGitRepo && (
          <Badge variant="outline" className="shrink-0 text-[10px] text-amber-700">
            No Git
          </Badge>
        )}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 @3xl/header-actions:gap-3">
        {vibecodeSelected ? (
          <Badge
            variant={vibecodeBadgeVariant}
            className="hidden shrink-0 gap-1.5 sm:inline-flex"
            title={vibecodeBadgeTitle}
          >
            <ZapIcon className="size-3" />
            {vibecodeBadgeText}
          </Badge>
        ) : null}
        {vibecodeSelected ? (
          <Badge
            variant={vibecodeRuntimeBadgeVariant}
            className="hidden shrink-0 gap-1.5 @4xl/header-actions:inline-flex"
            title={vibecodeRuntimeBadgeTitle}
          >
            {vibecodeRuntimeBadgeText}
          </Badge>
        ) : null}
        {vibecodeSelected ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  className="shrink-0"
                  pressed={false}
                  onPressedChange={onOpenPreview}
                  aria-label="Open project preview"
                  variant="outline"
                  size="xs"
                  disabled={!vibecodePreviewReady}
                >
                  <EyeIcon className="size-3" />
                </Toggle>
              }
            />
            <TooltipPopup side="bottom">{vibecodePreviewTooltip}</TooltipPopup>
          </Tooltip>
        ) : null}
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            {...(draftId ? { draftId } : {})}
          />
        )}
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={terminalOpen}
                onPressedChange={onToggleTerminal}
                aria-label="Toggle terminal drawer"
                variant="outline"
                size="xs"
                disabled={!terminalAvailable}
              >
                <TerminalSquareIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!terminalAvailable
              ? "Terminal is unavailable until this thread has an active project."
              : terminalToggleShortcutLabel
                ? `Toggle terminal drawer (${terminalToggleShortcutLabel})`
                : "Toggle terminal drawer"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                className="shrink-0"
                pressed={diffOpen}
                onPressedChange={onToggleDiff}
                aria-label="Toggle diff panel"
                variant="outline"
                size="xs"
                disabled={!isGitRepo && !diffOpen}
              >
                <DiffIcon className="size-3" />
              </Toggle>
            }
          />
          <TooltipPopup side="bottom">
            {!isGitRepo && !diffOpen
              ? "Diff panel is unavailable because this project is not a git repository."
              : diffToggleShortcutLabel
                ? `Toggle diff panel (${diffToggleShortcutLabel})`
                : "Toggle diff panel"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
});
