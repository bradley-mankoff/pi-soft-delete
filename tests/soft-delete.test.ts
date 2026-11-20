/**
 * Soft delete keeps a copy of what a destructive shell command will destroy before pi runs
 * it, and never stops the command. These tests drive the extension's `tool_call` handler
 * with a stand-in pi, against real scratch repos under a temporary folder.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { driveSessionStart, driveToolCall, loadSoftDelete, makeWorkspace, type Workspace } from "./stand-in-pi.ts";

/** Commit the given files in the scratch repo. */
const commitFiles = (workspace: Workspace, files: Record<string, string>): void => {
	for (const [name, text] of Object.entries(files)) writeFileSync(join(workspace.repo, name), text);
	execFileSync("git", ["-C", workspace.repo, "add", "."]);
	execFileSync("git", ["-C", workspace.repo, "commit", "-qm", "start"]);
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

/** The project's own folder, which is outside both /tmp and $TMPDIR. */
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A scratch folder outside the temporary folders, so a recursive delete needs a copy. */
const outsideTemporaryFolders = (prefix: string): string => mkdtempSync(join(projectRoot, prefix));

test("git checkout -- archives the changed content and a note naming the command, folder, session, rule and restore steps, without blocking", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace, { "notes.txt": "the committed notes\n" });
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

test("git clean -fd archives the untracked files", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace, { "kept.txt": "committed\n" });
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
		commitFiles(workspace, { "changed.txt": "committed\n", "untouched.txt": "untouched\n" });
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

test("rm -rf of a folder outside the temporary folders archives the folder", async () => {
	const workspace = makeWorkspace();
	const cwd = outsideTemporaryFolders(".soft-delete-cwd-");
	const victim = outsideTemporaryFolders(".soft-delete-victim-");
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
	const cwd = outsideTemporaryFolders(".soft-delete-cwd-");
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
		commitFiles(workspace, { "big.txt": "small\n" });
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

/** The date and time part of an archive folder name, in the archive's local-time format. */
const stampOf = (when: Date): string => {
	const pad = (value: number): string => String(value).padStart(2, "0");
	return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}_${pad(when.getHours())}-${pad(when.getMinutes())}-${pad(when.getSeconds())}`;
};

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
		commitFiles(workspace, { "notes.txt": "committed\n" });
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
		const old = backdatedArchive(workspace, "2020-01-01_00-00-00_git.checkout-double-dash", new Date("2020-01-01T00:00:00Z"));
		const now = new Date();
		const recent = backdatedArchive(workspace, `${stampOf(now)}_git.checkout-double-dash`, now);

		const handlers = loadSoftDelete(workspace.settings);
		await driveSessionStart(handlers, workspace);

		assert.equal(existsSync(old), false);
		assert.equal(existsSync(join(recent, "note.md")), true);
	} finally {
		clearWorkspace(workspace);
	}
});

test("the keep-days setting decides how old an archive may be", async () => {
	const workspace = makeWorkspace({ keepDays: 30 });
	try {
		const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
		const kept = backdatedArchive(workspace, `${stampOf(tenDaysAgo)}_git.checkout-double-dash`, tenDaysAgo);

		const handlers = loadSoftDelete(workspace.settings);
		await driveSessionStart(handlers, workspace);

		assert.equal(existsSync(join(kept, "note.md")), true);
	} finally {
		clearWorkspace(workspace);
	}
});

test("a command whose targets cannot be worked out gets a note only, saying so", async () => {
	const workspace = makeWorkspace();
	try {
		commitFiles(workspace, { "kept.txt": "committed\n" });
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
		commitFiles(workspace, { "kept.txt": "committed\n" });
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
		commitFiles(workspace, { "locked.txt": "committed\n" });
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
