# AGENTS.md

## Project

Standalone npm-installable CLI package for running labeled GitHub issues through coding agents in isolated git worktrees.

Repository:

- Local path: `/Users/ignacywielogorski/Developer/agent-loop-workflow`
- GitHub: `IgnacyWie/agent-loop-workflow`
- Public package install target: `github:IgnacyWie/agent-loop-workflow`

## Structure

- `bin/agent-loop.js` - executable Node.js CLI
- `package.json` - npm package metadata and `bin` mapping
- `README.md` - user-facing install and usage documentation
- `LICENSE` - MIT license

## Commands

```sh
npm run check                         # syntax-check the CLI
npm pack --dry-run                    # verify published package contents
npm exec --package . -- agent-loop --help
npx -y github:IgnacyWie/agent-loop-workflow --help
```

## Runtime Requirements

- Node.js 20+
- Git
- GitHub CLI authenticated with `gh auth login`
- A supported coding agent CLI:
  - `codex`
  - `claude`

The CLI is dependency-free and should remain runnable directly from the `bin` entry without a build step.

## Style

- Plain JavaScript ESM
- Tabs for indentation
- Double quotes
- No semicolons
- Keep comments sparse and only where they clarify non-obvious behavior
- Avoid introducing runtime dependencies unless they remove meaningful complexity

## Behavior

`agent-loop` must:

- Run from the target repository root
- Fetch open GitHub issues with the configured labels
- Detect dependencies from issue bodies
- Run eligible issues in dependency order
- Create one branch and git worktree per issue
- Invoke the selected agent in the issue worktree
- Merge successful issue branches into the launching branch
- Close successful GitHub issues unless `--no-close` is set
- Leave failed branches/worktrees available for inspection

## Safety

- Preserve the clean-main-worktree requirement before non-dry runs
- Do not silently delete failed worktrees
- Do not close or comment on issues from inside child-agent prompts
- Keep repo-specific prompt text configurable or generic
- Do not add package build tooling unless it is necessary for a concrete change

## Release Notes

This repo is currently installable from GitHub:

```sh
npx github:IgnacyWie/agent-loop-workflow --dry-run
npm install -g github:IgnacyWie/agent-loop-workflow
```

If publishing to npm later, update the README install section after `npm publish`.
