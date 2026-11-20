/**
 * The archive: what a destructive command would destroy, copied into a dated folder with a
 * note saying what was destroyed and how to put it back.
 *
 * A command is only archived when cc-safety-net would refuse it under a rule this package
 * knows destroys work: the git commands that discard uncommitted changes, and recursive
 * deletes. Nothing here decides whether the command runs; the caller lets it run either
 * way, and a failure to archive is reported in the note instead of thrown.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { checkCommand } from "cc-safety-net/api";

/** The settings under pi's `softDelete` key, after defaults are filled in. */
export type SoftDeleteSettings = {
	/** Where archives live; `~` and relative paths resolve from the home folder. */
	archiveRoot: string;
	/** How many days an archive is kept before it is purged. */
	keepDays: number;
	/** A target larger than this many bytes is named in the note, not copied. */
	maxBytes: number;
};

const DEFAULT_ARCHIVE_ROOT = join(homedir(), ".local", "share", "soft-delete");
const DEFAULT_KEEP_DAYS = 7;
const DEFAULT_MAX_BYTES = 1024 ** 3;

/** Resolve a leading `~` from the home folder, leaving every other path as written. */
const expandTilde = (path: string): string => {
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
};

/** pi's settings object as `pi.getSettings()` returns it, read for the `softDelete` key. */
export const settingsOf = (settings: unknown): SoftDeleteSettings => {
	const raw = (settings as { softDelete?: Partial<SoftDeleteSettings> } | undefined)?.softDelete ?? {};
	const archiveRoot = typeof raw.archiveRoot === "string" ? raw.archiveRoot.trim() : "";
	return {
		archiveRoot:
			archiveRoot !== "" ? resolve(homedir(), expandTilde(archiveRoot)) : DEFAULT_ARCHIVE_ROOT,
		keepDays:
			typeof raw.keepDays === "number" && Number.isFinite(raw.keepDays) && raw.keepDays >= 0
				? raw.keepDays
				: DEFAULT_KEEP_DAYS,
		maxBytes:
			typeof raw.maxBytes === "number" && Number.isFinite(raw.maxBytes) && raw.maxBytes > 0
				? raw.maxBytes
				: DEFAULT_MAX_BYTES,
	};
};

/** What kind of destruction a rule causes, when this package keeps a copy for it. */
type Destruction = "git-discard" | "recursive-delete";

/**
 * The rule ids whose denial means work is about to be destroyed, and what kind, matched by the
 * exact id cc-safety-net reports. Matching by substring misses ids such as `rm.git-metadata`,
 * whose name says what it protects rather than how it destroys, and catches ids of other kinds
 * (analysis or policy) that only mention destruction. cc-safety-net is pinned at 2.8.1; a rule
 * it adds later needs its id here. Only the POSIX rules appear: this package copies with `cp`
 * and treats /tmp as temporary, so its home is macOS.
 */
const GIT_DISCARD_RULES = new Set([
	"git.checkout-ambiguous",
	"git.checkout-double-dash",
	"git.checkout-force",
	"git.checkout-pathspec-from-file",
	"git.checkout-ref-path",
	"git.clean-force",
	"git.reset-hard",
	"git.reset-merge",
	"git.restore-unstaged",
	"git.restore-worktree",
	"git.stash-clear",
	"git.stash-drop",
	"git.switch-discard-changes",
	"git.switch-force",
]);

const RECURSIVE_DELETE_RULES = new Set([
	"rm.git-metadata",
	"rm.recursive-force-cwd-self",
	"rm.recursive-force-dynamic-target",
	"rm.recursive-force-home-cwd",
	"rm.recursive-force-outside-cwd",
	"rm.recursive-force-paranoid",
	"rm.recursive-force-root-or-home",
	"find.delete",
	"find.delete-git-metadata",
	"find.exec-rm-recursive-force",
	"xargs.rm-recursive-force-dynamic",
	"parallel.rm-recursive-force-dynamic",
]);

/** The delete rules whose targets another command supplies, so a note is all this package can write. */
const UNPARSED_DELETE_RULES = new Set([
	"find.delete",
	"find.delete-git-metadata",
	"find.exec-rm-recursive-force",
	"xargs.rm-recursive-force-dynamic",
	"parallel.rm-recursive-force-dynamic",
]);

/** The destruction a denied rule causes, or undefined for a rule that destroys no work this package copies. */
const destructionOf = (ruleId: string): Destruction | undefined => {
	if (GIT_DISCARD_RULES.has(ruleId)) return "git-discard";
	if (RECURSIVE_DELETE_RULES.has(ruleId)) return "recursive-delete";
	return undefined;
};

/** One thing to copy: where it is now, and where it goes in the archive. */
type Target = { label: string; source: string; stored: string };

/** Split a command into words the way sh quotes them, keeping operators as their own words. */
const tokenize = (command: string): string[] => {
	const tokens: string[] = [];
	let current = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	const push = (): void => {
		if (current !== "") tokens.push(current);
		current = "";
	};
	for (const character of command) {
		if (escaped) {
			current += character;
			escaped = false;
			continue;
		}
		if (character === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (character === quote) quote = undefined;
			else current += character;
			continue;
		}
		if (character === "'" || character === '"') {
			quote = character;
			continue;
		}
		if (/\s/.test(character)) {
			push();
			continue;
		}
		if ("&|;><".includes(character)) {
			push();
			tokens.push(character);
			continue;
		}
		current += character;
	}
	push();
	return tokens;
};

/** A word sh would expand before rm sees it: a variable, a glob or command substitution. */
const isDynamic = (word: string): boolean => /[$`*?\[\]{}]/.test(word) || (word.startsWith("~") && word !== "~" && !word.startsWith("~/"));

const OPERATORS = ["&", "|", ";", ">", "<"];

/** The tokens that separate one statement from the next; a redirection stays inside its statement. */
const STATEMENT_SEPARATORS = ["&", "|", ";"];

/**
 * The folder a command runs in: the tool call's cwd, moved by each `cd <literal>` that opens
 * an earlier statement. Anything else before the command (a wrapper such as `sudo`, a
 * variable assignment, a folder this package cannot read) leaves the folder unknown, because
 * copying some other folder's work would leave the work the command really destroys with no
 * copy. Git and rm share this reading, so `cd <folder> && <command>` lands in the folder the
 * cd names for either.
 */
const folderBefore = (tokens: string[], commandAt: number, cwd: string, name: string): { folder: string } | { unknown: string } => {
	let folder = cwd;
	let statementStart = true;
	for (let index = 0; index < commandAt; index += 1) {
		const token = tokens[index];
		if (OPERATORS.includes(token)) {
			statementStart = true;
			continue;
		}
		if (!statementStart || token.split("/").pop() !== "cd") {
			return { unknown: `the command runs \`${token}\` before ${name}, so its folder cannot be read` };
		}
		const target = tokens[index + 1];
		if (target === undefined || target === "-" || isDynamic(target)) {
			return { unknown: "the command changes folder with a path that cannot be read" };
		}
		folder = resolve(folder, expandTilde(target));
		index += 1;
		statementStart = false;
	}
	return { folder };
};

/**
 * The global options before a git subcommand (`-C <path>`, `--git-dir`, and the like), which
 * say which folder and repository git works in. A dynamic one is reported rather than passed
 * to git, because a path that cannot be read names no repository to copy from.
 */
const gitGlobalOptions = (tokens: string[], gitAt: number): { options: string[] } | { unknown: string } => {
	const options: string[] = [];
	for (let index = gitAt + 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token.startsWith("-") || token === "-" || OPERATORS.includes(token)) break;
		if (isDynamic(token)) return { unknown: `the option \`${token}\` names a folder that cannot be resolved` };
		options.push(token);
		if (!["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"].includes(token)) continue;
		const value = tokens[index + 1];
		if (value === undefined) return { unknown: `the option \`${token}\` has no value` };
		if (isDynamic(value)) return { unknown: `the value \`${value}\` of ${token} names a folder that cannot be resolved` };
		options.push(["-C", "--git-dir", "--work-tree", "--exec-path"].includes(token) ? expandTilde(value) : value);
		index += 1;
	}
	return { options };
};

/** The repository a git command runs in, and every changed and untracked file git status lists in it. */
const gitTargets = (command: string, cwd: string): { repo: string; targets: Target[] } | { unknown: string } => {
	const tokens = tokenize(command);
	const gitAt = tokens.findIndex((token) => token.split("/").pop() === "git");
	if (gitAt === -1) return { unknown: "the command does not name a git whose folder could be read" };
	const placed = folderBefore(tokens, gitAt, cwd, "git");
	if ("unknown" in placed) return placed;
	const parsed = gitGlobalOptions(tokens, gitAt);
	if ("unknown" in parsed) return parsed;
	const git = [...parsed.options];
	const top = spawnSync("git", [...git, "rev-parse", "--show-toplevel"], { cwd: placed.folder, encoding: "utf8" });
	if (top.status !== 0) return { unknown: "the folder is not a git repository" };
	const repo = top.stdout.trim();
	const status = spawnSync("git", [...git, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: placed.folder,
		encoding: "utf8",
	});
	if (status.status !== 0) return { unknown: "git status failed" };
	const entries = status.stdout.split("\0");
	const targets: Target[] = [];
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (!entry) continue;
		const state = entry.slice(0, 2);
		const path = entry.slice(3);
		if (state.includes("R") || state.includes("C")) index += 1;
		targets.push({ label: path, source: join(repo, path), stored: join("files", path) });
	}
	return { repo, targets };
};

/** Every temporary root a recursive delete may destroy without an archive. */
const temporaryRoots = (): string[] => {
	const roots = new Set<string>(["/tmp", "/private/tmp", tmpdir()]);
	const environmentTmp = process.env.TMPDIR;
	if (environmentTmp) roots.add(environmentTmp);
	for (const root of [...roots]) {
		try {
			roots.add(realpathSync(root));
		} catch {
			// A root that does not exist on this machine needs no alias.
		}
	}
	return [...roots];
};

const isWithin = (path: string, root: string): boolean => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Whether a path is inside /tmp or $TMPDIR, compared both as written and resolved. */
const isTemporary = (path: string): boolean => {
	const written = [path];
	try {
		written.push(realpathSync(path));
	} catch {
		// A path that no longer exists is compared as written.
	}
	return written.some((candidate) => temporaryRoots().some((root) => isWithin(candidate, root)));
};

/**
 * The paths an rm command names, or the reason its targets cannot be worked out. The folder
 * is the one an earlier `cd` names, as for git, so `cd <folder> && rm -rf <relative>` copies
 * the folder it really deletes. A target in a temporary folder is dropped: destroying it
 * loses nothing worth keeping.
 */
const deleteTargets = (command: string, cwd: string): { paths: string[] } | { unknown: string } => {
	const tokens = tokenize(command);
	const rmAt = tokens.findIndex((token) => token.split("/").pop() === "rm");
	if (rmAt === -1) return { unknown: "the command does not name an rm whose targets could be read" };
	const placed = folderBefore(tokens, rmAt, cwd, "rm");
	if ("unknown" in placed) return placed;
	const operands: string[] = [];
	let optionsEnded = false;
	for (const token of tokens.slice(rmAt + 1)) {
		if (["&", "|", ";", ">", "<"].includes(token)) break;
		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && token.startsWith("-") && token !== "-") continue;
		operands.push(token);
	}
	if (operands.length === 0) return { unknown: "the command names no path" };
	const paths: string[] = [];
	for (const operand of operands) {
		if (isDynamic(operand)) return { unknown: `the target \`${operand}\` is a variable or a glob` };
		const path = resolve(placed.folder, expandTilde(operand));
		if (!isTemporary(path)) paths.push(path);
	}
	return { paths };
};

/** Copy a file or folder, cloning it on APFS and falling back to a plain copy elsewhere. */
const copy = (source: string, destination: string): void => {
	const cloned = spawnSync("cp", ["-c", "-R", source, destination], { encoding: "utf8" });
	if (cloned.status === 0) return;
	const plain = spawnSync("cp", ["-R", source, destination], { encoding: "utf8" });
	if (plain.status !== 0) throw new Error((plain.stderr || cloned.stderr || "cp failed").trim());
};

/**
 * The bytes a target holds, without following symlinks, stopping as soon as the running total
 * passes the cap: a folder far over it costs one subtree, not the whole tree. A folder that
 * cannot be listed counts for nothing and is left to the copy to report, so one unreadable
 * corner does not turn a listed target into an unmeasured one.
 */
const sizeOf = (path: string, remaining: number): number => {
	const stats = lstatSync(path);
	if (!stats.isDirectory()) return stats.size;
	let total = 0;
	let names: string[];
	try {
		names = readdirSync(path);
	} catch {
		return total;
	}
	for (const name of names) {
		total += sizeOf(join(path, name), Math.max(remaining - total, 1));
		if (total > remaining) return total;
	}
	return total;
};

/** A folder name pi-soft-delete owns: date, time, then the rule id. */
const folderName = (now: Date, ruleId: string): string => {
	const pad = (value: number): string => String(value).padStart(2, "0");
	const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
	return `${stamp}_${ruleId.replace(/[^A-Za-z0-9._-]/g, "-")}`;
};

const uniqueFolder = (root: string, name: string): string => {
	let candidate = join(root, name);
	for (let suffix = 2; existsSync(candidate); suffix += 1) candidate = join(root, `${name}_${suffix}`);
	return candidate;
};

const ARCHIVE_NAME = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})/;

/** When an archive folder was written, from the date and time at the start of its name. */
const createdFromName = (name: string): number | undefined => {
	const match = ARCHIVE_NAME.exec(name);
	if (!match) return undefined;
	const [, year, month, day, hour, minute, second] = match.map(Number);
	const created = new Date(year, month - 1, day, hour, minute, second).getTime();
	return Number.isNaN(created) ? undefined : created;
};

/** Delete archive folders older than the keep-days. A folder whose name is not one this package wrote is left alone. */
export const purgeArchives = (settings: SoftDeleteSettings, now: Date = new Date()): string[] => {
	if (!existsSync(settings.archiveRoot)) return [];
	const cutoff = now.getTime() - settings.keepDays * 24 * 60 * 60 * 1000;
	const removed: string[] = [];
	for (const entry of readdirSync(settings.archiveRoot, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const created = createdFromName(entry.name);
		if (created === undefined || created >= cutoff) continue;
		const folder = join(settings.archiveRoot, entry.name);
		try {
			rmSync(folder, { recursive: true, force: true });
			removed.push(folder);
		} catch {
			// A folder that cannot be removed now is tried again at the next archive.
		}
	}
	return removed;
};

/** The command word whose statement cc-safety-net refused, so the parts after that statement can be named. */
const refusedWord = (destruction: Destruction, ruleId: string): string => {
	if (destruction === "git-discard") return "git";
	if (ruleId.startsWith("find.")) return "find";
	if (ruleId.startsWith("xargs.")) return "xargs";
	if (ruleId.startsWith("parallel.")) return "parallel";
	return "rm";
};

/**
 * The statements a command runs after the one that holds the refused command, as written.
 * cc-safety-net reports one refusal per command, so a later destructive part gets no copy;
 * the note names those parts so the loss is not silent.
 */
const laterStatements = (tokens: string[], commandAt: number): string[] => {
	if (commandAt < 0) return [];
	const statements: string[] = [];
	let current: string[] = [];
	let commandEnded = false;
	for (const token of tokens.slice(commandAt + 1)) {
		if (!STATEMENT_SEPARATORS.includes(token)) {
			if (commandEnded) current.push(token);
			continue;
		}
		if (commandEnded && current.length > 0) statements.push(current.join(" "));
		if (commandEnded) current = [];
		commandEnded = true;
	}
	if (current.length > 0) statements.push(current.join(" "));
	return statements;
};

const restoreLines = (destruction: Destruction, archive: string, copied: Target[], repo: string | undefined): string[] => {
	if (copied.length === 0) return [];
	if (destruction === "git-discard") {
		if (repo === undefined) return [];
		return ["Copy the archived files back over the repository:", "", `    cp -R '${archive}/files/.' '${repo}/'`];
	}
	return copied.flatMap((target) => [`    cp -R '${join(archive, target.stored)}' '${target.label}'`]);
};

/** Write the note beside the copies: the command, where it ran, the session, the rule and the restore steps. */
const writeNote = (options: {
	archive: string;
	command: string;
	cwd: string;
	sessionFile: string | undefined;
	ruleId: string;
	now: Date;
	destruction: Destruction;
	repo: string | undefined;
	unknown: string | undefined;
	later: string[];
	copied: Target[];
	notCopied: { label: string; why: string }[];
}): void => {
	const { archive, command, cwd, sessionFile, ruleId, now, destruction, repo, unknown, later, copied, notCopied } = options;
	const lines = [
		"# Soft delete archive",
		"",
		`- Command: \`${command}\``,
		`- Folder: ${cwd}`,
		`- Session file: ${sessionFile ?? "(unknown)"}`,
		`- Rule: ${ruleId}`,
		...(repo !== undefined ? [`- Repository: ${repo}`] : []),
		`- Created: ${now.toISOString()}`,
		"",
	];
	if (unknown) lines.push("## Targets not worked out", "", `Nothing was copied: ${unknown}.`, "");
	if (later.length > 0) {
		lines.push(
			"## Not examined",
			"",
			"This command runs more than one part, and only the first refusal is reported. Only the part that holds the refused command was archived; these later parts were not examined, so a destructive one among them has no copy:",
			"",
			...later.map((statement) => `- \`${statement}\``),
			"",
		);
	}
	lines.push("## Restore", "");
	const restore = restoreLines(destruction, archive, copied, repo);
	lines.push(...(restore.length > 0 ? restore : ["Nothing was copied, so there is nothing to restore."]));
	lines.push("", "## Copied", "");
	lines.push(...(copied.length > 0 ? copied.map((target) => `- ${target.label} (at \`${target.stored}\`)`) : ["- nothing"]));
	if (notCopied.length > 0) {
		lines.push("", "## Not copied", "");
		lines.push(...notCopied.map((target) => `- ${target.label} (${target.why})`));
	}
	lines.push("");
	writeFileSync(join(archive, "note.md"), lines.join("\n"));
};

/**
 * Copy what a destructive command will destroy, if cc-safety-net would refuse the command
 * under a rule this package keeps copies for. Returns the archive folder, or undefined when
 * the command is allowed or destroys nothing this package archives.
 */
export const archiveCommand = (options: {
	command: string;
	cwd: string;
	sessionFile: string | undefined;
	settings: SoftDeleteSettings;
	now?: Date;
}): string | undefined => {
	const { command, cwd, sessionFile, settings, now = new Date() } = options;
	if (command.trim() === "" || !isAbsolute(cwd)) return undefined;
	const verdict = checkCommand({ command, cwd });
	if (verdict.kind !== "deny") return undefined;
	const destruction = destructionOf(verdict.ruleId);
	if (!destruction) return undefined;

	let repo: string | undefined;
	let targets: Target[];
	let unknown: string | undefined;
	if (destruction === "git-discard") {
		const listed = gitTargets(command, cwd);
		if ("unknown" in listed) {
			unknown = `the changed files could not be listed because ${listed.unknown}`;
			targets = [];
		} else {
			repo = listed.repo;
			targets = listed.targets;
		}
	} else {
		if (UNPARSED_DELETE_RULES.has(verdict.ruleId)) {
			unknown = "the command's targets could not be worked out: another command (a pipe, xargs or find) supplies them";
			targets = [];
		} else {
			const listed = deleteTargets(command, cwd);
			if ("unknown" in listed) {
				unknown = `the command's targets could not be worked out: ${listed.unknown}`;
				targets = [];
			} else {
				targets = listed.paths.map((path) => ({ label: path, source: path, stored: join("files", path.slice(1)) }));
				if (targets.length === 0) return undefined;
			}
		}
	}

	purgeArchives(settings, now);
	const tokens = tokenize(command);
	const word = refusedWord(destruction, verdict.ruleId);
	const later = laterStatements(tokens, tokens.findIndex((token) => token.split("/").pop() === word));
	const archive = uniqueFolder(settings.archiveRoot, folderName(now, verdict.ruleId));
	const copied: Target[] = [];
	const notCopied: { label: string; why: string }[] = [];
	mkdirSync(archive, { recursive: true });
	for (const target of targets) {
		const destination = join(archive, target.stored);
		try {
			if (isWithin(target.source, settings.archiveRoot) || isWithin(settings.archiveRoot, target.source)) {
				notCopied.push({ label: target.label, why: "inside the archive root" });
				continue;
			}
			if (!existsSync(target.source)) {
				notCopied.push({ label: target.label, why: "not on disk" });
				continue;
			}
			if (sizeOf(target.source, settings.maxBytes) > settings.maxBytes) {
				notCopied.push({ label: target.label, why: `over the ${settings.maxBytes}-byte size cap` });
				continue;
			}
			mkdirSync(dirname(destination), { recursive: true });
			copy(target.source, destination);
			copied.push(target);
		} catch (error) {
			notCopied.push({ label: target.label, why: `copy failed: ${error instanceof Error ? error.message : String(error)}` });
		}
	}
	writeNote({ archive, command, cwd, sessionFile, ruleId: verdict.ruleId, now, destruction, repo, unknown, later, copied, notCopied });
	return archive;
};
