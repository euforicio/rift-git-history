# Changelog

All notable changes to Git History are documented here.

## [0.3.0] - 2026-08-28

### Added

- Uncommitted files now appear above commit history, including staged, modified, deleted, and untracked files.
- Working-tree files open in the native diff viewer when a textual patch is available.
- The Uncommitted section can be expanded or collapsed and starts collapsed by default.

## [0.2.0] - 2026-08-26

### Added

- File diffs can switch between wrapped long lines and horizontal scrolling.

### Fixed

- Ref labels now collapse into a `+N` counter before they overflow narrow panels.
- Expanded commit messages wrap instead of truncating long text.
- Internal t3 checkpoint refs and checkpoint-only commits no longer appear in history.

## [0.1.1] - 2026-08-24

### Fixed

- Returning from a file diff now preserves the history scroll position without leaving a blank gap above the virtualized commit list.

## [0.1.0] - 2026-08-24

### Added

- Complete repository history across local branches, remote-tracking branches, tags, stashes, and shared worktrees.
- Compact colored branch and merge graph with responsive layouts for narrow and wide panels.
- Inline changed-file summaries and bb-native per-file diffs.
- Virtualized incremental loading and search across loaded commits.
- Light, dark, and custom bb theme support.
- Read-only Git inspection on local and connected bb hosts.
