# Git History for bb

Git History adds a compact, read-only commit graph to a thread's right panel.
It reads every ref in the repository, so the graph includes local branches,
remote-tracking branches, tags, stashes, and shared worktree history.

## Install

Install the latest compatible release from GitHub:

```sh
bb plugin install git:https://github.com/yusuf8834/bb-git-history.git@^0.1.0
```

For local development:

```sh
npm install --include=dev
npm run build
bb plugin install .
```

Open a project thread and select the Git folder button in its header. Git
History is also available from the right panel's Actions list.

## What it shows

- Topologically ordered commits reachable from `git log --all`
- Colored branch and merge lanes
- Local, remote, tag, stash, and `HEAD` labels
- Commit author, date, full message, and first-parent changed files
- Per-file patches rendered by bb's native diff viewer
- Infinite loading with virtualized rows

The plugin does not run checkout, reset, merge, rebase, or other Git mutations.
Commits reachable only through reflogs are not part of the main graph.

## Development

```sh
npm test
npx tsc --noEmit
npm run build
```

The host entry runs Git on the thread environment's bb host. This keeps the
same behavior for local worktrees and repositories on connected machines.

## License

[MIT](LICENSE)
