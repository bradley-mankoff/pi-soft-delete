/**
 * A stand-in for pi: it keeps the handlers an extension registers so a test can call the
 * one it cares about, and answers `getSettings()` with what the test wrote. The extension
 * itself is loaded by its default export, the same entry point pi uses.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import type { SoftDeleteSettings } from "../extensions/archive.ts";
import softDelete from "../extensions/soft-delete.ts";

export type Workspace = {
	/** The one temporary folder every other path lives under. */
	dir: string;
	repo: string;
	archiveRoot: string;
	safetyNetHome: string;
	sessionFile: string;
	settings: { softDelete: SoftDeleteSettings };
};

/** Make a folder a git repository whose commits need no global identity. */
export const initScratchRepo = (repo: string): void => {
	execFileSync("git", ["init", "-q", repo]);
	execFileSync("git", ["-C", repo, "config", "user.name", "Soft Delete Test"]);
	execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
};

/** One temporary machine: a scratch git repo, an archive root, and cc-safety-net's home. */
export const makeWorkspace = (overrides: Partial<SoftDeleteSettings> = {}): Workspace => {
	const dir = mkdtempSync(join(tmpdir(), "pi-soft-delete-"));
	const repo = join(dir, "repo");
	const archiveRoot = join(dir, "archives");
	const safetyNetHome = join(dir, "cc-safety-net");
	const sessionFile = join(dir, "session.jsonl");
	mkdirSync(repo, { recursive: true });
	mkdirSync(safetyNetHome, { recursive: true });
	initScratchRepo(repo);
	return {
		dir,
		repo,
		archiveRoot,
		safetyNetHome,
		sessionFile,
		settings: {
			softDelete: { archiveRoot, keepDays: 7, maxBytes: 1024 ** 3, ...overrides },
		},
	};
};

type Handlers = {
	toolCall?: (event: ToolCallEvent, ctx: ExtensionContext) => Promise<ToolCallEventResult | void> | ToolCallEventResult | void;
	sessionStart?: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void> | void;
};

/** Load the extension against a stand-in pi and return the handlers it registered. */
export const loadSoftDelete = (settings: unknown): Handlers => {
	const handlers: Handlers = {};
	const pi = {
		on(event: string, handler: unknown) {
			if (event === "tool_call") handlers.toolCall = handler as Handlers["toolCall"];
			if (event === "session_start") handlers.sessionStart = handler as Handlers["sessionStart"];
			return () => {};
		},
		getSettings: () => settings,
	} as unknown as ExtensionAPI;
	softDelete(pi);
	return handlers;
};

export const contextFor = (cwd: string, sessionFile: string): ExtensionContext =>
	({
		cwd,
		sessionManager: { getSessionFile: () => sessionFile },
	}) as unknown as ExtensionContext;

export const bashCall = (command: string): ToolCallEvent => ({
	type: "tool_call",
	toolCallId: "call-1",
	toolName: "bash",
	input: { command },
});

/**
 * Drive the extension's `tool_call` handler as pi does before a bash command runs: the
 * archive root and cc-safety-net's home point at the workspace's temporary folders.
 */
export const driveToolCall = async (
	handlers: Handlers,
	workspace: Workspace,
	command: string,
	cwd: string = workspace.repo,
): Promise<ToolCallEventResult | void> => {
	if (!handlers.toolCall) throw new Error("the extension registered no tool_call handler");
	process.env.CC_SAFETY_NET_HOME = realpathSync(workspace.safetyNetHome);
	return handlers.toolCall(bashCall(command), contextFor(cwd, workspace.sessionFile));
};

/** Drive the extension's `session_start` handler as pi does when a session opens. */
export const driveSessionStart = async (handlers: Handlers, workspace: Workspace): Promise<void> => {
	if (!handlers.sessionStart) throw new Error("the extension registered no session_start handler");
	process.env.CC_SAFETY_NET_HOME = realpathSync(workspace.safetyNetHome);
	await handlers.sessionStart({ type: "session_start", reason: "startup" }, contextFor(workspace.repo, workspace.sessionFile));
};
