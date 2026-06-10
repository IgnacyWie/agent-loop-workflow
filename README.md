# Agent Loop Workflow

Run GitHub issues through a headless coding agent in isolated git worktrees.

`agent-loop` finds open issues with configurable labels, detects issue dependencies from the issue body, runs eligible issues in dependency order, asks a coding agent to implement each issue on its own branch, merges successful branches back into the current branch, and closes the issue.

## Requirements

- Node.js 20 or newer
- Git
- GitHub CLI, authenticated with `gh auth login`
- One supported coding agent CLI:
  - `codex`
  - `claude`

Run it from the root of the repository whose issues you want to process.

## Install

Run without installing:

```sh
npx github:IgnacyWie/agent-loop-workflow --dry-run
```

Install with Homebrew:

```sh
brew tap IgnacyWie/tap
brew install agent-loop-workflow
agent-loop --dry-run
```

Install globally with npm:

```sh
npm install -g github:IgnacyWie/agent-loop-workflow
agent-loop --dry-run
```

The global install exposes the `agent-loop` command on your normal npm global binary path. If global npm binaries are not already on your shell `PATH`, run:

```sh
npm bin -g
```

Then add that directory to your shell profile.

## Usage

```sh
agent-loop
agent-loop --agent codex
agent-loop --agent claude
agent-loop --parallel 3
agent-loop --parallel 3 --tmux
agent-loop --parallel 3 --tmux --no-tmux-attach
agent-loop --dry-run
agent-loop --setup-labels
agent-loop --labels ready-for-agent,automated-agent
agent-loop --worktree-dir ../agent-worktrees
```

By default, `agent-loop` selects open issues with both labels:

- `ready-for-agent`
- `automated-agent`

It creates or updates the `aa-in-progress` label when an issue starts.

Before running a repository for the first time, create the expected issue labels:

```sh
agent-loop --setup-labels
```

This creates or updates the configured required labels and the in-progress label in the current GitHub repository, then exits. For custom labels, pass the same label options you use for normal runs:

```sh
agent-loop --setup-labels --labels ready-for-agent,automated-agent --in-progress-label aa-in-progress
```

## Matt Pocock AI Skills

`agent-loop` works perfectly with [Matt Pocock's AI skills](https://github.com/mattpocock/skills), especially `grill-me`, `to-prd`, and `to-issues`.

Use those skills to stress-test an idea, turn it into a PRD, and break it into independently-grabbable GitHub issues. Then label the ready issues for `agent-loop` to run through coding agents in dependency order.

## Dependency Detection

Dependencies are inferred from issue bodies. If both issues are in the selected set, `agent-loop` waits for the dependency issue to complete first.

Dry runs and normal runs print execution waves followed by an ASCII dependency tree so you can see blockers/unblocks at a glance.

Supported inline forms:

```md
Depends on #12
Blocked by #12
Requires #12
Prerequisites: #12
```

Supported section forms:

```md
## Depends on

- #12
- #13
```

## Options

| Option | Default | Description |
| --- | --- | --- |
| `--agent <codex|claude>` | `codex` | Agent CLI to run |
| `--parallel <n>` | `5` | Max number of agents running at once |
| `--labels <a,b>` | `ready-for-agent,automated-agent` | Required issue labels |
| `--in-progress-label <label>` | `aa-in-progress` | Label added while an issue is running |
| `--worktree-dir <path>` | `.agent-worktrees` | Directory for git worktrees |
| `--base-branch <branch>` | current branch | Branch used for new issue worktrees |
| `--repo-name <name>` | current directory name | Human-readable repository name in agent prompts |
| `--tmux` | `false` | Run agent commands in tmux with one window per dependency wave and split panes for active issues |
| `--no-tmux-attach` | `false` | Create the tmux session without automatically attaching to it |
| `--setup-labels` | `false` | Create or update required GitHub issue labels, then exit |
| `--dry-run` | `false` | Print planned execution waves without running agents |
| `--no-close` | `false` | Merge successful branches but do not close GitHub issues |
| `--no-push` | `false` | Merge successful branches but do not push the launching branch |
| `--help` | | Show help |

Environment variable equivalents:

```sh
AGENT_LOOP_AGENT=claude
AGENT_LOOP_PARALLEL=3
AGENT_LOOP_LABELS=ready-for-agent,automated-agent
AGENT_LOOP_IN_PROGRESS_LABEL=aa-in-progress
AGENT_LOOP_WORKTREE_DIR=.agent-worktrees
AGENT_LOOP_BASE_BRANCH=main
AGENT_LOOP_REPO_NAME=my-repo
AGENT_LOOP_TMUX=1
AGENT_LOOP_TMUX_ATTACH=0
AGENT_LOOP_NO_CLOSE=1
AGENT_LOOP_NO_PUSH=1
```

## Tmux Mode

Pass `--tmux` to watch active agents in tmux:

```sh
agent-loop --parallel 5 --tmux
```

The parent process prints the session name and attach command before agents start, then automatically attaches to the session when stdin is an interactive terminal. If you launch from inside tmux, `agent-loop` switches the current tmux client to the new session instead. Pass `--no-tmux-attach` or set `AGENT_LOOP_TMUX_ATTACH=0` to create the session without attaching.

Each dependency wave gets one tmux window/tab named `wave-N`. Issues in that wave run as split panes in the same tab with a tiled layout.

Issue panes stay open after the agent exits so you can inspect terminal output without a separate log file. Exit the pane shell when you are done with it. Failed branches and worktrees are still preserved for inspection.

`agent-loop` does not write run log files. In non-tmux mode, agent output streams directly to the launching terminal.

## Development

```sh
npm run check
npm run demo:tree
npm test
npm run test:package
```

`npm run demo:tree` prints a local sample dependency tree using fake issue data. It does not call GitHub or create commits.

## Safety Model

Before running agents, `agent-loop` requires the main worktree to be clean. Each issue gets a branch named `agent/issue-N` and a separate worktree. Successful branches are merged into the branch where you launched `agent-loop`, then that launching branch is pushed to `origin`.

If an agent fails, the issue branch and worktree are left in place for inspection, and the GitHub issue is not modified beyond the in-progress label.

## Agent Prompt

Each agent receives the issue title, body, target branch, worktree path, and generic implementation instructions. The prompt tells the child agent to commit its changes and not push, close, or comment on the issue, because `agent-loop` owns merge, push, and closure.

## Publishing to npm

The package is ready for npm publishing if you want a shorter command later:

```sh
npm publish
npx agent-loop-workflow --dry-run
```
