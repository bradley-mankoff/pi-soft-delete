/**
 * soft-delete: keeps a copy of what a destructive bash command will destroy, then lets the
 * command run. It never refuses a command.
 *
 * Before pi runs a bash command, this extension asks cc-safety-net's `checkCommand` whether
 * a guard would refuse it. When the answer is deny under a rule that destroys work (a git
 * discard or a recursive delete, never a secret.* read), it writes an archive with what the
 * command will destroy and a note on how to restore it. A failure to archive is swallowed:
 * the command still runs.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { archiveCommand, purgeArchives, settingsOf } from "./archive.ts";

export default function softDelete(pi: ExtensionAPI): void {
	pi.on("session_start", () => {
		try {
			purgeArchives(settingsOf(pi.getSettings()));
		} catch {
			// A purge that fails must not stop the session from starting.
		}
	});

	pi.on("tool_call", (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = event.input?.command;
		if (typeof command !== "string" || command.trim() === "") return;
		try {
			archiveCommand({
				command,
				cwd: ctx.cwd,
				sessionFile: ctx.sessionManager.getSessionFile(),
				settings: settingsOf(pi.getSettings()),
			});
		} catch {
			// Archiving must never stop a command.
		}
	});
}
