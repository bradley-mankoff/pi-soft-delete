/**
 * The archive: what a destructive command would destroy, copied into a dated folder with a
 * note saying what was destroyed and how to put it back.
 *
 * A command is only archived when cc-safety-net would refuse it under a rule this package
 * knows destroys work: the git commands that discard uncommitted changes or move a ref, and
 * recursive deletes. Nothing here decides whether the command runs; the caller lets it run
 * either way, and a failure to archive is reported in the note instead of thrown.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
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
type Destruction = "git-discard" | "git-ref" | "recursive-delete";

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

/**
 * The rule ids whose denial means a git ref is about to move or disappear, taking the commits
 * only it could reach. A force push is denied as `git.push-force` whether it names a ref, uses
 * `+` in the refspec, or carries a lease alongside `--force`; `--force-with-lease` alone is
 * allowed, so this package never has to archive it.
 */
const GIT_REF_RULES = new Set([
	"git.branch-force-delete",
	"git.push-delete",
	"git.push-force",
	"git.push-mirror",
	"git.tag-delete",
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

/**
 * The command that supplies the paths a refused delete would remove, when it is not rm itself:
 * find, xargs or parallel names the targets at run time, so a note is all this package can write.
 * The rule-id prefixes say this once for the archive and the note; a rule of one of these tools
 * added later needs no second list.
 */
const targetSupplier = (ruleId: string): "find" | "xargs" | "parallel" | undefined => {
	if (ruleId.startsWith("find.")) return "find";
	if (ruleId.startsWith("xargs.")) return "xargs";
	if (ruleId.startsWith("parallel.")) return "parallel";
	return undefined;
};

/** The destruction a denied rule causes, or undefined for a rule that destroys no work this package copies. */
const destructionOf = (ruleId: string): Destruction | undefined => {
	if (GIT_DISCARD_RULES.has(ruleId)) return "git-discard";
	if (GIT_REF_RULES.has(ruleId)) return "git-ref";
	if (RECURSIVE_DELETE_RULES.has(ruleId)) return "recursive-delete";
	return undefined;
};

/** One thing to copy: where it is now, and where it goes in the archive. */
type Target = { label: string; source: string; stored: string };

/** A target this package could not copy, and why, so the note can name what was left behind. */
type NotCopied = { label: string; why: string };

/** Where a command word sits in the tokens, counting `/bin/rm` as `rm`. */
const wordIndex = (tokens: string[], word: string): number => tokens.findIndex((token) => token.split("/").pop() === word);

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

/** The tokens that end a command's arguments. */
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
const folderBefore = (tokens: string[], commandAt: number, cwd: string, commandWord: string): { folder: string } | { unknown: string } => {
	let folder = cwd;
	let statementStart = true;
	for (let index = 0; index < commandAt; index += 1) {
		const token = tokens[index];
		if (OPERATORS.includes(token)) {
			statementStart = true;
			continue;
		}
		if (!statementStart || token.split("/").pop() !== "cd") {
			return { unknown: `the command runs \`${token}\` before ${commandWord}, so its folder cannot be read` };
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

/** git's global options that take the next word as their value. */
const GIT_OPTIONS_TAKING_A_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/** Those of them whose value is a folder, so a leading `~` is resolved before git reads it. */
const GIT_FOLDER_OPTIONS = new Set(["-C", "--git-dir", "--work-tree", "--exec-path"]);

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
		if (!GIT_OPTIONS_TAKING_A_VALUE.has(token)) continue;
		const value = tokens[index + 1];
		if (value === undefined) return { unknown: `the option \`${token}\` has no value` };
		if (isDynamic(value)) return { unknown: `the value \`${value}\` of ${token} cannot be read` };
		options.push(GIT_FOLDER_OPTIONS.has(token) ? expandTilde(value) : value);
		index += 1;
	}
	return { options };
};

/** Where a git command runs and which repository it names, after its global options. */
type GitPlacement = { repo: string; tokens: string[]; gitAt: number; options: string[] };

/**
 * The repository a git command names, read from the tool call's folder and the absolute options
 * that choose another (`-C`, `--git-dir`, ...). Git and every subcommand share this reading, so
 * `cd <folder> && git ...` and `git -C <folder> ...` archive from the repository they name.
 */
const gitPlacement = (command: string, cwd: string): GitPlacement | { unknown: string } => {
	const tokens = tokenize(command);
	const gitAt = wordIndex(tokens, "git");
	if (gitAt === -1) return { unknown: "the command does not name a git whose folder could be read" };
	const placed = folderBefore(tokens, gitAt, cwd, "git");
	if ("unknown" in placed) return placed;
	const parsed = gitGlobalOptions(tokens, gitAt);
	if ("unknown" in parsed) return parsed;
	const top = spawnSync("git", [...parsed.options, "rev-parse", "--show-toplevel"], { cwd: placed.folder, encoding: "utf8" });
	if (top.status !== 0) return { unknown: "the folder is not a git repository" };
	return { repo: top.stdout.trim(), tokens, gitAt, options: parsed.options };
};

/** The repository a git command runs in, and every changed and untracked file git status lists in it. */
const gitTargets = (command: string, cwd: string): { repo: string; targets: Target[] } | { unknown: string } => {
	const placement = gitPlacement(command, cwd);
	if ("unknown" in placement) return placement;
	const status = spawnSync("git", [...placement.options, "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
		cwd: placement.repo,
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
		targets.push({ label: path, source: join(placement.repo, path), stored: join("files", path) });
	}
	return { repo: placement.repo, targets };
};

/** Run git in a repository, answering its output or the first line of what went wrong. */
const runGit = (repo: string, args: string[]): { ok: true; stdout: string } | { ok: false; why: string } => {
	const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	if (result.status === 0) return { ok: true, stdout: result.stdout.trim() };
	const why = (result.stderr || result.stdout || `git ${args.join(" ")} failed`).trim().split("\n")[0] ?? "git failed";
	return { ok: false, why };
};

/** A ref inside a bundle, with its old tip and where the restore puts it back. */
type KeptRef = { label: string; tip: string; head: string; restore: string };

/** A bundle holding one ref, or every ref a mirror push can move. */
type KeptBundle = { stored: string; refs: KeptRef[] };

/** A ref this package meant to bundle but could not, and why, so the note names what was lost. */
type NotKeptRef = { label: string; why: string };

/** One bundle to write: the refs it holds, and the temporary refs to delete once it does. */
type BundlePlan = { label: string; stored: string; refs: KeptRef[]; cleanup: string[] };

/** A ref name made safe for a file name or a ref path component. */
const bundleSlug = (name: string): string => name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^-+/, "");

/** A ref's name without the namespace that says whether it is a branch or a tag. */
const shortRef = (ref: string): string => ref.replace(/^refs\/(?:heads|tags)\//, "");

/** The kind of ref a full name holds, for a file name or a temporary ref of its own. */
const refKind = (ref: string): "branch" | "tag" | "ref" =>
	ref.startsWith("refs/tags/") ? "tag" : ref.startsWith("refs/heads/") ? "branch" : "ref";

/** The file a bundle of these refs is stored under, named so two refs never share one by accident. */
const bundleStored = (owner: string, ref: string): string =>
	join("bundles", `${bundleSlug(`${owner}-${refKind(ref)}-${shortRef(ref)}`)}.bundle`);

/** Whether a local ref exists, without letting git print its answer. */
const localRefExists = (repo: string, ref: string): boolean => runGit(repo, ["show-ref", "--verify", "--quiet", ref]).ok;

/**
 * A plan that bundles an existing local ref. A force-deleted branch or tag still exists while
 * the command is being archived, so the bundle names it as it stands and the restore's fetch
 * puts the same name back.
 */
const localRefPlan = (repo: string, ref: string, label: string): { plan?: BundlePlan; missing?: NotKeptRef } => {
	const tip = runGit(repo, ["rev-parse", "--verify", ref]);
	if (!tip.ok) return { missing: { label, why: `the ref could not be read: ${tip.why}` } };
	return {
		plan: {
			label,
			stored: bundleStored("local", ref),
			refs: [{ label, tip: tip.stdout, head: ref, restore: ref }],
			cleanup: [],
		},
	};
};

/**
 * A plan that bundles a remote ref, fetched into a temporary ref of this package's own so the
 * bundle holds the remote's tip as it is now rather than a stale remote-tracking copy. The
 * temporary ref lives only until the bundle is written; its name is the head the note tells the
 * reader to fetch back.
 */
const remoteRefPlan = (
	repo: string,
	remote: string,
	candidates: string[],
	label: string,
): { plan?: BundlePlan; missing?: NotKeptRef } => {
	const failures: string[] = [];
	for (const ref of candidates) {
		const head = `refs/soft-delete-archive/${process.pid}/${bundleSlug(`${remote}-${refKind(ref)}-${shortRef(ref)}`)}`;
		const fetched = runGit(repo, ["fetch", "--no-tags", remote, `+${ref}:${head}`]);
		if (!fetched.ok) {
			runGit(repo, ["update-ref", "-d", head]);
			failures.push(fetched.why);
			continue;
		}
		const tip = runGit(repo, ["rev-parse", "--verify", head]);
		if (!tip.ok) {
			runGit(repo, ["update-ref", "-d", head]);
			failures.push(tip.why);
			continue;
		}
		return {
			plan: {
				label,
				stored: bundleStored(remote, ref),
				refs: [{ label, tip: tip.stdout, head, restore: ref }],
				cleanup: [head],
			},
		};
	}
	return { missing: { label, why: `the remote ref could not be fetched: ${failures.join("; ")}` } };
};

/** The git subcommand after a git command's global options, and where it sits in the tokens. */
const gitSubcommand = (tokens: string[], gitAt: number): { at: number; name: string } | undefined => {
	for (let index = gitAt + 1; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (!token.startsWith("-") || token === "-") return { at: index, name: token };
		if (GIT_OPTIONS_TAKING_A_VALUE.has(token)) index += 1;
	}
	return undefined;
};

/** git push options that take the next word as their value, rather than `=` on the same word. */
const PUSH_OPTIONS_TAKING_A_VALUE = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec", "--recurse-submodules"]);

/** What a push command says about its remote and the refs it moves. */
type PushSpec = {
	delete: boolean;
	mirror: boolean;
	all: boolean;
	tags: boolean;
	remote: string;
	refspecs: string[];
};

/** The remote a push without one named uses: the branch's push remote, then the user's default, then origin. */
const defaultRemote = (repo: string): string => {
	const branch = runGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	const keys = [
		...(branch.ok ? [`branch.${branch.stdout}.pushRemote`, "remote.pushDefault", `branch.${branch.stdout}.remote`] : ["remote.pushDefault"]),
	];
	for (const key of keys) {
		const configured = runGit(repo, ["config", "--get", key]);
		if (configured.ok && configured.stdout !== "" && configured.stdout !== ".") return configured.stdout;
	}
	return "origin";
};

/** The branch checked out in a repository, or undefined when HEAD is detached. */
const currentBranch = (repo: string): string | undefined => {
	const head = runGit(repo, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
	return head.ok ? head.stdout : undefined;
};

/** Read a git push command's options, remote and refspecs; the first operand is always the remote. */
const parsePush = (tokens: string[], start: number, repo: string): PushSpec => {
	let del = false;
	let mirror = false;
	let all = false;
	let tags = false;
	const operands: string[] = [];
	let optionsEnded = false;
	for (let index = start; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (OPERATORS.includes(token)) break;
		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && token.startsWith("-") && token !== "-") {
			if (token === "--delete" || token === "-d" || /^-[A-Za-z]*d/.test(token)) del = true;
			if (token === "--mirror") mirror = true;
			if (token === "--all" || token === "--branches") all = true;
			if (token === "--tags") tags = true;
			const option = token.split("=", 1)[0];
			if (PUSH_OPTIONS_TAKING_A_VALUE.has(option) && !token.includes("=")) index += 1;
			continue;
		}
		operands.push(token);
	}
	const [namedRemote, ...refspecs] = operands;
	return { delete: del, mirror, all, tags, remote: namedRemote ?? defaultRemote(repo), refspecs };
};

/** What a refspec moves: the ref on the remote, and whether the command deletes it. */
type RefMove = { remoteRef: string; delete: boolean };

/** The remote ref a refspec names, reading `:old`, `old`, `src:old`, `+old` and their full forms alike. */
const refMoveOf = (repo: string, refspec: string, deleting: boolean): RefMove => {
	const body = refspec.startsWith("+") ? refspec.slice(1) : refspec;
	if (deleting) return { remoteRef: body.startsWith(":") ? body.slice(1) : body, delete: true };
	if (body.startsWith(":")) return { remoteRef: body.slice(1), delete: true };
	const colon = body.indexOf(":");
	const source = colon === -1 ? body : body.slice(0, colon);
	const destination = colon === -1 ? body : body.slice(colon + 1);
	if (destination === "") return { remoteRef: source, delete: true };
	if (destination.startsWith("refs/")) return { remoteRef: destination, delete: false };
	const sourceIsTag =
		source.startsWith("refs/tags/") ||
		(source !== "" && localRefExists(repo, `refs/tags/${source}`) && !localRefExists(repo, `refs/heads/${source}`));
	return { remoteRef: `${sourceIsTag ? "refs/tags" : "refs/heads"}/${destination}`, delete: false };
};

/** One bundle plan per remote ref a push moves, fetching each first so its old tip is current. */
const pushPlans = (repo: string, spec: PushSpec): { plans: BundlePlan[]; missing: NotKeptRef[]; unknown?: string } => {
	if (spec.mirror) {
		const listed = runGit(repo, ["ls-remote", "--refs", "--heads", "--tags", spec.remote]);
		if (!listed.ok) {
			return { plans: [], missing: [{ label: `the refs on ${spec.remote}`, why: `the remote could not be listed: ${listed.why}` }] };
		}
		const remoteRefs = listed.stdout
			.split("\n")
			.filter(Boolean)
			.map((line) => line.split("\t")[1] ?? "")
			.filter(Boolean);
		if (remoteRefs.length === 0) return { plans: [], missing: [], unknown: `the remote ${spec.remote} reports no ref to keep` };
		const refs: KeptRef[] = [];
		const cleanup: string[] = [];
		const missing: NotKeptRef[] = [];
		for (const remoteRef of remoteRefs) {
			const head = `refs/soft-delete-archive/${process.pid}/${bundleSlug(`${spec.remote}-${refKind(remoteRef)}-${shortRef(remoteRef)}`)}`;
			const fetched = runGit(repo, ["fetch", "--no-tags", spec.remote, `+${remoteRef}:${head}`]);
			if (!fetched.ok) {
				runGit(repo, ["update-ref", "-d", head]);
				missing.push({ label: `${spec.remote}/${shortRef(remoteRef)}`, why: `the remote ref could not be fetched: ${fetched.why}` });
				continue;
			}
			const tip = runGit(repo, ["rev-parse", "--verify", head]);
			if (!tip.ok) {
				runGit(repo, ["update-ref", "-d", head]);
				missing.push({ label: `${spec.remote}/${shortRef(remoteRef)}`, why: `the remote ref could not be read: ${tip.why}` });
				continue;
			}
			refs.push({ label: `${spec.remote}/${shortRef(remoteRef)}`, tip: tip.stdout, head, restore: remoteRef });
			cleanup.push(head);
		}
		if (refs.length === 0) return { plans: [], missing };
		return {
			plans: [{ label: `every ref on ${spec.remote}`, stored: join("bundles", `${bundleSlug(spec.remote)}-mirror.bundle`), refs, cleanup }],
			missing,
		};
	}

	const plans: BundlePlan[] = [];
	const missing: NotKeptRef[] = [];
	const add = (remoteRef: string): void => {
		const label = `${spec.remote}/${shortRef(remoteRef)}`;
		const kept = remoteRefPlan(repo, spec.remote, [remoteRef], label);
		if (kept.plan) plans.push(kept.plan);
		if (kept.missing) missing.push(kept.missing);
	};

	if (spec.all || spec.tags) {
		const namespace = spec.all ? "refs/heads" : "refs/tags";
		const listed = runGit(repo, ["for-each-ref", "--format=%(refname)", namespace]);
		if (!listed.ok) return { plans, missing, unknown: `the refs could not be listed: ${listed.why}` };
		const refs = listed.stdout.split("\n").filter(Boolean);
		if (refs.length === 0) return { plans, missing, unknown: "the command names no ref to push" };
		for (const ref of refs) add(ref);
		return { plans, missing };
	}

	if (spec.refspecs.length === 0) {
		const branch = currentBranch(repo);
		if (branch === undefined) return { plans, missing, unknown: "the command pushes the current branch, and HEAD is detached" };
		add(`refs/heads/${branch}`);
		return { plans, missing };
	}

	for (const refspec of spec.refspecs) {
		const move = refMoveOf(repo, refspec, spec.delete);
		if (move.remoteRef === "") return { plans, missing, unknown: `the refspec \`${refspec}\` names no ref` };
		if (move.delete) {
			const label = `${spec.remote}/${shortRef(move.remoteRef)}`;
			const candidates = move.remoteRef.startsWith("refs/")
				? [move.remoteRef]
				: [`refs/heads/${move.remoteRef}`, `refs/tags/${move.remoteRef}`];
			const kept = remoteRefPlan(repo, spec.remote, candidates, label);
			if (kept.plan) plans.push(kept.plan);
			if (kept.missing) missing.push(kept.missing);
			continue;
		}
		add(move.remoteRef);
	}
	return { plans, missing };
};

/** The refs a refused branch or tag deletion removes, as bundle plans. */
const localDeletePlans = (repo: string, tokens: string[], start: number, namespace: "refs/heads" | "refs/tags"): { plans: BundlePlan[]; missing: NotKeptRef[]; unknown?: string } => {
	const names: string[] = [];
	let optionsEnded = false;
	for (let index = start; index < tokens.length; index += 1) {
		const token = tokens[index];
		if (OPERATORS.includes(token)) break;
		if (!optionsEnded && token === "--") {
			optionsEnded = true;
			continue;
		}
		if (!optionsEnded && token.startsWith("-") && token !== "-") continue;
		names.push(token);
	}
	if (names.length === 0) return { plans: [], missing: [], unknown: "the command names no ref to delete" };
	const plans: BundlePlan[] = [];
	const missing: NotKeptRef[] = [];
	for (const name of names) {
		const ref = `${namespace}/${name}`;
		const kept = localRefPlan(repo, ref, name);
		if (kept.plan) plans.push(kept.plan);
		if (kept.missing) missing.push(kept.missing);
	}
	return { plans, missing };
};

/** The bundle plans for the refs a refused force push, branch delete, tag delete or mirror push moves. */
const gitRefPlans = (
	command: string,
	cwd: string,
): { repo: string; plans: BundlePlan[]; missing: NotKeptRef[]; unknown?: string } | { unknown: string } => {
	const placement = gitPlacement(command, cwd);
	if ("unknown" in placement) return placement;
	const subcommand = gitSubcommand(placement.tokens, placement.gitAt);
	if (subcommand === undefined) return { unknown: "the command names no git subcommand" };
	const { repo, tokens } = placement;
	if (subcommand.name === "branch") return { repo, ...localDeletePlans(repo, tokens, subcommand.at + 1, "refs/heads") };
	if (subcommand.name === "tag") return { repo, ...localDeletePlans(repo, tokens, subcommand.at + 1, "refs/tags") };
	if (subcommand.name === "push") return { repo, ...pushPlans(repo, parsePush(tokens, subcommand.at + 1, repo)) };
	return { unknown: `the command moves no ref this package knows how to keep` };
};

/** Build the planned bundles and delete the temporary refs they hold, naming any that fail. */
const writeBundles = (options: {
	repo: string;
	archive: string;
	plans: BundlePlan[];
	maxBytes: number;
}): { bundles: KeptBundle[]; notBundled: NotKeptRef[] } => {
	const bundles: KeptBundle[] = [];
	const notBundled: NotKeptRef[] = [];
	for (const plan of options.plans) {
		const destination = join(options.archive, plan.stored);
		try {
			if (plan.refs.length === 0) continue;
			mkdirSync(dirname(destination), { recursive: true });
			const created = runGit(options.repo, ["bundle", "create", destination, ...plan.refs.map((ref) => ref.head)]);
			if (!created.ok) {
				rmSync(destination, { force: true });
				notBundled.push({ label: plan.label, why: `bundle failed: ${created.why}` });
				continue;
			}
			if (statSync(destination).size > options.maxBytes) {
				rmSync(destination, { force: true });
				notBundled.push({ label: plan.label, why: `over the ${options.maxBytes}-byte size cap` });
				continue;
			}
			bundles.push({ stored: plan.stored, refs: plan.refs });
		} catch (error) {
			rmSync(destination, { force: true });
			notBundled.push({ label: plan.label, why: `bundle failed: ${error instanceof Error ? error.message : String(error)}` });
		} finally {
			for (const ref of plan.cleanup) runGit(options.repo, ["update-ref", "-d", ref]);
		}
	}
	return { bundles, notBundled };
};

/** Keep the old tips of the refs a refused command moves, as bundles the note says how to fetch back. */
const keepGitRefs = (options: {
	command: string;
	cwd: string;
	archive: string;
	maxBytes: number;
}): { repo: string | undefined; bundles: KeptBundle[]; notBundled: NotKeptRef[]; unknown: string | undefined } => {
	const listed = gitRefPlans(options.command, options.cwd);
	if ("unknown" in listed && !("repo" in listed)) {
		return { repo: undefined, bundles: [], notBundled: [], unknown: listed.unknown };
	}
	const written = writeBundles({ repo: listed.repo, archive: options.archive, plans: listed.plans, maxBytes: options.maxBytes });
	return {
		repo: listed.repo,
		bundles: written.bundles,
		notBundled: [...listed.missing, ...written.notBundled],
		unknown: listed.unknown,
	};
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
	const rmAt = wordIndex(tokens, "rm");
	if (rmAt === -1) return { unknown: "the command does not name an rm whose targets could be read" };
	const placed = folderBefore(tokens, rmAt, cwd, "rm");
	if ("unknown" in placed) return placed;
	const operands: string[] = [];
	let optionsEnded = false;
	for (const token of tokens.slice(rmAt + 1)) {
		if (OPERATORS.includes(token)) break;
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
const refusedWord = (destruction: Destruction, ruleId: string): string =>
	destruction === "git-discard" || destruction === "git-ref" ? "git" : (targetSupplier(ruleId) ?? "rm");

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

/** The fetch commands that put each bundled ref back, as the reader would run them. */
const bundleRestoreLines = (archive: string, bundles: KeptBundle[]): string[] => {
	if (bundles.length === 0) return [];
	return [
		"Fetch each ref back from its bundle; `--update-head-ok` lets the fetch also move a branch that is checked out, which `git reset --hard` then brings into the working tree:",
		"",
		...bundles.flatMap((bundle) =>
			bundle.refs.map((ref) => `    git fetch --update-head-ok '${join(archive, bundle.stored)}' '+${ref.head}:${ref.restore}'`),
		),
	];
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
	notCopied: NotCopied[];
	bundles?: KeptBundle[];
	notBundled?: NotKeptRef[];
}): void => {
	const { archive, command, cwd, sessionFile, ruleId, now, destruction, repo, unknown, later, copied, notCopied } = options;
	const bundles = options.bundles ?? [];
	const notBundled = options.notBundled ?? [];
	const isRef = destruction === "git-ref";
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
	if (unknown) lines.push("## Targets not worked out", "", `Nothing was ${isRef ? "bundled" : "copied"}: ${unknown}.`, "");
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
	const restore = isRef ? bundleRestoreLines(archive, bundles) : restoreLines(destruction, archive, copied, repo);
	lines.push(...(restore.length > 0 ? restore : [`Nothing was ${isRef ? "bundled" : "copied"}, so there is nothing to restore.`]));
	if (isRef) {
		lines.push("", "## Bundled refs", "");
		lines.push(
			...(bundles.length > 0
				? bundles.flatMap((bundle) => bundle.refs.map((ref) => `- ${ref.label} was at \`${ref.tip}\` (in \`${bundle.stored}\`)`))
				: ["- nothing"]),
		);
		if (notBundled.length > 0) {
			lines.push("", "## Not bundled", "");
			lines.push(...notBundled.map((ref) => `- ${ref.label} (${ref.why})`));
		}
	} else {
		lines.push("", "## Copied", "");
		lines.push(...(copied.length > 0 ? copied.map((target) => `- ${target.label} (at \`${target.stored}\`)`) : ["- nothing"]));
		if (notCopied.length > 0) {
			lines.push("", "## Not copied", "");
			lines.push(...notCopied.map((target) => `- ${target.label} (${target.why})`));
		}
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
}): string | undefined => {
	const { command, cwd, sessionFile, settings } = options;
	if (command.trim() === "" || !isAbsolute(cwd)) return undefined;
	const verdict = checkCommand({ command, cwd });
	if (verdict.kind !== "deny") return undefined;
	const destruction = destructionOf(verdict.ruleId);
	if (!destruction) return undefined;

	const tokens = tokenize(command);
	const later = laterStatements(tokens, wordIndex(tokens, refusedWord(destruction, verdict.ruleId)));

	if (destruction === "git-ref") {
		const now = new Date();
		purgeArchives(settings, now);
		const archive = uniqueFolder(settings.archiveRoot, folderName(now, verdict.ruleId));
		mkdirSync(archive, { recursive: true });
		const kept = keepGitRefs({ command, cwd, archive, maxBytes: settings.maxBytes });
		writeNote({
			archive,
			command,
			cwd,
			sessionFile,
			ruleId: verdict.ruleId,
			now,
			destruction,
			repo: kept.repo,
			unknown: kept.unknown,
			later,
			copied: [],
			notCopied: [],
			bundles: kept.bundles,
			notBundled: kept.notBundled,
		});
		return archive;
	}

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
		if (targetSupplier(verdict.ruleId) !== undefined) {
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

	const now = new Date();
	purgeArchives(settings, now);
	const archive = uniqueFolder(settings.archiveRoot, folderName(now, verdict.ruleId));
	const copied: Target[] = [];
	const notCopied: NotCopied[] = [];
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
