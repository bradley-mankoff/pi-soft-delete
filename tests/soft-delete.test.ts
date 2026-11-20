/**
 * Soft delete keeps a copy of what a destructive shell command will destroy before pi runs
 * it, and never stops the command. These tests drive the extension's `tool_call` handler
 * with a stand-in pi, against real scratch repos: under a temporary folder for the archives
 * and cc-safety-net's home, and under /Users/Shared where a target must be outside /tmp.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { driveSessionStart, driveToolCall, initScratchRepo, loadSoftDelete, makeWorkspace, type Workspace } from "./stand-in-pi.ts";

/** Commit the given files in the given scratch repo. */
const commitFiles = (repo: string, files: Record<string, string>): void => {
	for (const [name, text] of Object.entries(files)) writeFileSync(join(repo, name), text);
	execFileSync("git", ["-C", repo, "add", "."]);
	execFileSync("git", ["-C", repo, "commit", "-qm", "start"]);
};

/** The archive folders the archive root holds, newest name last. */
const archiveFolders = (workspace: Workspace): string[] =>
	existsSync(workspace.archiveRoot)
		? readdirSync(workspace.archiveRoot, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => join(workspace.archiveRoot, entry.name))
				.sort()
		: [];

const onlyArchive = (workspace: Workspace): string => {
	const folders = archiveFolders(workspace);
	assert.equal(folders.length, 1, `expected one archive, found ${JSON.stringify(folders)}`);
	return folders[0];
};

const noteOf = (archive: string): string => readFileSync(join(archive, "note.md"), "utf8");

const clearWorkspace = (workspace: Workspace): void => rmSync(workspace.dir, { recursive: true, force: true });

/**
 * A scratch folder outside the temporary folders, so a recursive delete needs a copy, and
 * outside every home folder, so the tests touch the real home folder nowhere. /Users/Shared
 * is the one writable folder on a Mac that is neither temporary nor inside a home folder.
 */
const outsideTemporaryFolders = (prefix: string): string => mkdtempSync(join("/Users/Shared", prefix));

/** A scratch git repo under a folder outside the temporary folders, for deletes of `.git`. */
const scratchRepo = (): string => {
	const repo = outsideTemporaryFolders("pi-soft-delete-repo-");
	initScratchRepo(repo);
	return repo;
};

test("git checkout -- archives the changed content and a note naming the command, folder, session, rule and restore steps, without blocking", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace.repo, { "notes.txt": "the committed notes\n" });
		writeFileSync(join(workspace.repo, "notes.txt"), "the uncommitted notes\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, "git checkout -- notes.txt");

		assert.equal(result, undefined, "the handler must not block the command");
		const archive = onlyArchive(workspace);
		assert.equal(readFileSync(join(archive, "files", "notes.txt"), "utf8"), "the uncommitted notes\n");

		const note = noteOf(archive);
		assert.ok(note.includes("git checkout -- notes.txt"), note);
		assert.ok(note.includes(workspace.repo), note);
		assert.ok(note.includes(workspace.sessionFile), note);
		assert.ok(note.includes("git.checkout-double-dash"), note);
		assert.match(note, /restore/i);
		assert.match(note, /cp -R/);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a git discard run with git -C archives the repository it names and restores into it", async () => {
	const workspace = makeWorkspace();
	const repo = scratchRepo();
	try {
		commitFiles(repo, { "notes.txt": "committed\n" });
		writeFileSync(join(repo, "notes.txt"), "changed in the repository git -C names\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, `git -C ${repo} checkout -- notes.txt`, dirname(repo));

		assert.equal(result, undefined);
		const archive = onlyArchive(workspace);
		assert.equal(
			readFileSync(join(archive, "files", "notes.txt"), "utf8"),
			"changed in the repository git -C names\n",
		);
		const note = noteOf(archive);
		assert.ok(note.includes(`cp -R '${archive}/files/.' '${repo}/'`), note);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		clearWorkspace(workspace);
	}
});

test("a git discard behind a literal cd archives the repository the cd names", async () => {
	const workspace = makeWorkspace();
	const repo = scratchRepo();
	const elsewhere = scratchRepo();
	try {
		commitFiles(repo, { "notes.txt": "committed\n" });
		writeFileSync(join(repo, "notes.txt"), "changed in the repository the cd names\n");
		writeFileSync(join(elsewhere, "notes.txt"), "changed in the repository the tool call ran in\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, `cd ${repo} && git checkout -- notes.txt`, elsewhere);

		assert.equal(result, undefined);
		const archive = onlyArchive(workspace);
		assert.equal(
			readFileSync(join(archive, "files", "notes.txt"), "utf8"),
			"changed in the repository the cd names\n",
		);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		rmSync(elsewhere, { recursive: true, force: true });
		clearWorkspace(workspace);
	}
});

test("a git discard whose repository cannot be read notes that nothing was copied, with no restore command", async () => {
	const workspace = makeWorkspace();
	const folder = outsideTemporaryFolders("pi-soft-delete-norepo-");
	try {
		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, "git checkout -- notes.txt", folder);

		assert.equal(result, undefined);
		const note = noteOf(onlyArchive(workspace));
		assert.match(note, /nothing was copied/i);
		assert.doesNotMatch(note, /cp -R/);
	} finally {
		rmSync(folder, { recursive: true, force: true });
		clearWorkspace(workspace);
	}
});

test("git clean -fd archives the untracked files", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace.repo, { "kept.txt": "committed\n" });
		writeFileSync(join(workspace.repo, "draft.txt"), "an untracked draft\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, "git clean -fd");

		assert.equal(result, undefined);
		const archive = onlyArchive(workspace);
		assert.equal(readFileSync(join(archive, "files", "draft.txt"), "utf8"), "an untracked draft\n");
	} finally {
		clearWorkspace(workspace);
	}
});

test("git reset --hard archives every changed and untracked file", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace.repo, { "changed.txt": "committed\n", "untouched.txt": "untouched\n" });
		writeFileSync(join(workspace.repo, "changed.txt"), "changed in the working tree\n");
		writeFileSync(join(workspace.repo, "fresh.txt"), "untracked and new\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, "git reset --hard");

		assert.equal(result, undefined);
		const archive = onlyArchive(workspace);
		assert.equal(readFileSync(join(archive, "files", "changed.txt"), "utf8"), "changed in the working tree\n");
		assert.equal(readFileSync(join(archive, "files", "fresh.txt"), "utf8"), "untracked and new\n");
	} finally {
		clearWorkspace(workspace);
	}
});

test("rm -rf .git archives the git metadata under the rule that protects it", async () => {
	const workspace = makeWorkspace();
	const repo = scratchRepo();
	try {
		commitFiles(repo, { "kept.txt": "committed\n" });
		writeFileSync(join(repo, ".git", "soft-delete-proof"), "the unpushed history a deleted .git would lose\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, "rm -rf .git", repo);

		assert.equal(result, undefined, "the handler must not block the command");
		const archive = onlyArchive(workspace);
		assert.equal(
			readFileSync(join(archive, "files", repo.slice(1), ".git", "soft-delete-proof"), "utf8"),
			"the unpushed history a deleted .git would lose\n",
		);
		const note = noteOf(archive);
		assert.ok(note.includes("rm.git-metadata"), note);
	} finally {
		rmSync(repo, { recursive: true, force: true });
		clearWorkspace(workspace);
	}
});

test("a recursive delete behind a literal cd archives the folder the cd names", async () => {
	const workspace = makeWorkspace();
	const cwd = outsideTemporaryFolders("pi-soft-delete-cwd-");
	const target = outsideTemporaryFolders("pi-soft-delete-target-");
	try {
		mkdirSync(join(cwd, "sub"));
		writeFileSync(join(cwd, "sub", "kept.txt"), "the folder the tool call ran in\n");
		mkdirSync(join(target, "sub"));
		writeFileSync(join(target, "sub", "kept.txt"), "the folder the cd names\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, `cd ${target} && rm -rf sub`, cwd);

		assert.equal(result, undefined);
		const archive = onlyArchive(workspace);
		assert.equal(
			readFileSync(join(archive, "files", target.slice(1), "sub", "kept.txt"), "utf8"),
			"the folder the cd names\n",
		);
		const note = noteOf(archive);
		assert.ok(
			note.includes(`cp -R '${join(archive, "files", target.slice(1), "sub")}' '${join(target, "sub")}'`),
			note,
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(target, { recursive: true, force: true });
		clearWorkspace(workspace);
	}
});

test("rm -rf of a folder outside the temporary folders archives the folder", async () => {
	const workspace = makeWorkspace();
	const cwd = outsideTemporaryFolders("pi-soft-delete-cwd-");
	const victim = outsideTemporaryFolders("pi-soft-delete-victim-");
	try {
		mkdirSync(join(victim, "inner"));
		writeFileSync(join(victim, "inner", "kept.txt"), "the folder's contents\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, `rm -rf ${victim}`, cwd);

		assert.equal(result, undefined);
		const archive = onlyArchive(workspace);
		assert.equal(
			readFileSync(join(archive, "files", victim.slice(1), "inner", "kept.txt"), "utf8"),
			"the folder's contents\n",
		);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(victim, { recursive: true, force: true });
		clearWorkspace(workspace);
	}
});

test("rm -rf of a folder inside /tmp archives nothing", async () => {
	const workspace = makeWorkspace();
	const cwd = outsideTemporaryFolders("pi-soft-delete-cwd-");
	const victim = mkdtempSync("/tmp/pi-soft-delete-victim-");
	try {
		writeFileSync(join(victim, "kept.txt"), "the temporary folder's contents\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, `rm -rf ${victim}`, cwd);

		assert.equal(result, undefined);
		assert.deepEqual(archiveFolders(workspace), []);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
		rmSync(victim, { recursive: true, force: true });
		clearWorkspace(workspace);
	}
});

test("a target over the size cap is named in the note but not copied", async () => {
	const workspace = makeWorkspace({ maxBytes: 16 });
	try {
		commitFiles(workspace.repo, { "big.txt": "small\n" });
		writeFileSync(join(workspace.repo, "big.txt"), "more than sixteen bytes of uncommitted text\n");

		const handlers = loadSoftDelete(workspace.settings);
		await driveToolCall(handlers, workspace, "git checkout -- big.txt");

		const archive = onlyArchive(workspace);
		assert.equal(existsSync(join(archive, "files", "big.txt")), false);
		const note = noteOf(archive);
		assert.ok(note.includes("big.txt"), note);
		assert.match(note, /size cap/i);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a target over the size cap is named as over the cap even when part of it cannot be read", async () => {
	const workspace = makeWorkspace({ maxBytes: 16 });
	const cwd = outsideTemporaryFolders("pi-soft-delete-cwd-");
	const victim = outsideTemporaryFolders("pi-soft-delete-unreadable-");
	try {
		writeFileSync(join(victim, "big.txt"), "more than sixteen bytes of text\n");
		mkdirSync(join(victim, "locked"));
		writeFileSync(join(victim, "locked", "inner.txt"), "inner text\n");
		chmodSync(join(victim, "locked"), 0o000);

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, `rm -rf ${victim}`, cwd);

		assert.equal(result, undefined);
		const note = noteOf(onlyArchive(workspace));
		assert.match(note, /size cap/i);
		assert.doesNotMatch(note, /copy failed/i);
	} finally {
		chmodSync(join(victim, "locked"), 0o700);
		rmSync(cwd, { recursive: true, force: true });
		rmSync(victim, { recursive: true, force: true });
		clearWorkspace(workspace);
	}
});

/** A folder in the archive root as an earlier run left it, backdated by name and mtime. */
const backdatedArchive = (workspace: Workspace, name: string, when: Date): string => {
	const folder = join(workspace.archiveRoot, name);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "note.md"), "an archive from an earlier run\n");
	utimesSync(folder, when, when);
	return folder;
};

test("an archive older than the keep-days is deleted when the next archive is written", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace.repo, { "notes.txt": "committed\n" });
		writeFileSync(join(workspace.repo, "notes.txt"), "uncommitted\n");
		const old = backdatedArchive(workspace, "2020-01-01_00-00-00_git.checkout-double-dash", new Date("2020-01-01T00:00:00Z"));

		const handlers = loadSoftDelete(workspace.settings);
		await driveToolCall(handlers, workspace, "git checkout -- notes.txt");

		assert.equal(existsSync(old), false);
		assert.equal(archiveFolders(workspace).length, 1);
	} finally {
		clearWorkspace(workspace);
	}
});

test("archives older than the keep-days are deleted when a session starts", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace.repo, { "notes.txt": "committed\n" });
		writeFileSync(join(workspace.repo, "notes.txt"), "uncommitted\n");
		const handlers = loadSoftDelete(workspace.settings);
		await driveToolCall(handlers, workspace, "git checkout -- notes.txt");
		const recent = onlyArchive(workspace);
		const old = backdatedArchive(workspace, "2020-01-01_00-00-00_git.checkout-double-dash", new Date("2020-01-01T00:00:00Z"));

		await driveSessionStart(handlers, workspace);

		assert.equal(existsSync(old), false);
		assert.equal(existsSync(join(recent, "note.md")), true);
	} finally {
		clearWorkspace(workspace);
	}
});

test("the keep-days setting decides how old an archive may be", async () => {
	// 100 years, so an archive from 2000 survives, where the default 7 days would delete it.
	const workspace = makeWorkspace({ keepDays: 36500 });
	try {
		const kept = backdatedArchive(workspace, "2000-01-01_00-00-00_git.checkout-double-dash", new Date("2000-01-01T00:00:00Z"));

		const handlers = loadSoftDelete(workspace.settings);
		await driveSessionStart(handlers, workspace);

		assert.equal(existsSync(join(kept, "note.md")), true);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a chained command notes the later parts it did not examine", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace.repo, { "notes.txt": "committed\n" });
		writeFileSync(join(workspace.repo, "notes.txt"), "uncommitted\n");
		mkdirSync(join(workspace.repo, "sub"));
		writeFileSync(join(workspace.repo, "sub", "kept.txt"), "the later part's contents\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, "git checkout -- . ; rm -rf sub");

		assert.equal(result, undefined);
		const note = noteOf(onlyArchive(workspace));
		assert.match(note, /## Not examined[\s\S]*- `rm -rf sub`/);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a command whose targets cannot be worked out gets a note only, saying so", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace.repo, { "kept.txt": "committed\n" });
		writeFileSync(join(workspace.repo, "draft.txt"), "an untracked draft\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, "find . -name '*.txt' | xargs rm -rf");

		assert.equal(result, undefined);
		const archive = onlyArchive(workspace);
		assert.match(noteOf(archive), /could not be worked out/);
		assert.equal(existsSync(join(archive, "files")), false);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a secret rule archives nothing, because reading a secret destroys no work", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace.repo, { "kept.txt": "committed\n" });
		writeFileSync(join(workspace.repo, ".env"), "A_SECRET=1\n");

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, "cat .env");

		assert.equal(result, undefined);
		assert.deepEqual(archiveFolders(workspace), []);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a failed copy is named in the note and the handler still does not block", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace.repo, { "locked.txt": "committed\n" });
		const locked = join(workspace.repo, "locked.txt");
		writeFileSync(locked, "changed but unreadable\n");
		chmodSync(locked, 0o000);

		const handlers = loadSoftDelete(workspace.settings);
		const result = await driveToolCall(handlers, workspace, "git checkout -- locked.txt");

		assert.equal(result, undefined);
		const archive = onlyArchive(workspace);
		assert.match(noteOf(archive), /copy failed/i);
		assert.equal(existsSync(join(archive, "files", "locked.txt")), false);
	} finally {
		clearWorkspace(workspace);
	}
});
