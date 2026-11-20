# pi-soft-delete

A pi package that makes an agent's destructive shell commands recoverable instead of refused.

Before pi runs a bash command, the extension asks [cc-safety-net](https://github.com/kenryu42/cc-safety-net) whether a guard would refuse it. When the answer is deny under a rule that destroys work, the extension copies what the command will destroy into a dated archive folder, writes a note on how to put it back, and then lets the command run. The command is never blocked.

## What it archives

- **A git discard** — `git checkout`, `git restore`, `git reset --hard`, `git clean -f`, `git stash drop` or `clear`, `git switch` with discard — keeps every changed and untracked file `git status` lists in the repository the command names, including one named by `git -C` or an earlier `cd`.
- **A recursive delete outside `/tmp` and `$TMPDIR`** keeps each named path that exists, including a `.git` folder, whose loss takes every unpushed commit and stash with it. `rm -rf /tmp/...` archives nothing. A target inside the archive root itself is not copied.
- **A command whose targets cannot be worked out** — a variable, a glob, a pipe into `xargs` or `find`, or another command before `git` that hides which repository it uses — gets a note only, saying so.

Rules that only read, including every `secret.*` rule, archive nothing because reading destroys nothing.

Copies are APFS clones (`cp -c`), with a plain copy as the fallback. A target larger than the size cap is named in the note but not copied. A failed copy is written in the note, and the command still runs.

## Each archive

One folder per destruction, under the archive root, named for its date, time and the rule id, for example `2026-11-20_15-04-05_git.checkout-double-dash`. It holds:

- `note.md` — the command, the folder it ran in, the pi session file, the rule id, what was copied, what was not, and the restore steps.
- `files/` — the copies. A git discard mirrors paths relative to the repository root, so `cp -R '<archive>/files/.' '<repo>/'` restores it. A recursive delete mirrors the deleted target's absolute path, and the note gives the exact command that restores each target.

Archives older than the keep-days are purged whenever a new archive is written and when a session starts. There is no scheduled job.

## Settings

Put settings under the `softDelete` key in pi's `settings.json` (global or project):

```json
{
  "softDelete": {
    "archiveRoot": "~/.local/share/soft-delete/",
    "keepDays": 7,
    "maxBytes": 1073741824
  }
}
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `archiveRoot` | `~/.local/share/soft-delete/` | Where archive folders live. `~` and relative paths resolve from the home folder. |
| `keepDays` | `7` | How many days an archive is kept. |
| `maxBytes` | `1073741824` (1 GiB) | A target larger than this is named in the note but not copied. |

## Install

Add the package to pi alongside the guards you want it to follow:

```bash
pi install npm:pi-soft-delete
```

The extension lives in `extensions/soft-delete.ts`.

## Test

```bash
npm install
npm test
```

The tests use Node's test runner, a stand-in pi, and real scratch repositories under a temporary folder. They point the archive root and cc-safety-net's home (`CC_SAFETY_NET_HOME`) at temporary folders. The one test that needs a folder outside the temporary folders makes its scratch folders under `/Users/Shared`, which is outside every home folder, so no test reads or writes the real home folder.
