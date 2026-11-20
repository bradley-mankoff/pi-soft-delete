# pi-soft-delete

A pi package that makes an agent's destructive shell commands recoverable instead of refused. Before a command runs that [cc-safety-net](https://github.com/kenryu42/cc-safety-net) would refuse (a hard reset, a checkout over changed files, a recursive delete outside the temporary folders, a force push), the extension keeps a copy of what the command will destroy in a dated archive folder, with a note on how to put it back. Then it lets the command run. Archives older than seven days are purged.

Not built yet: the first version is tracked in this repo's Beads.
