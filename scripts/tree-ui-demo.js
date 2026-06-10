#!/usr/bin/env node

import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"
import process from "node:process"

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)))
const cliPath = join(repoRoot, "bin", "agent-loop.js")
const workspace = mkdtempSync(join(tmpdir(), "agent-loop-tree-demo-"))
const binDir = join(workspace, "bin")
const fakeGh = join(binDir, "gh")

const issues = [
	{ number: 1, title: "Define agent run contract", body: "" },
	{ number: 2, title: "Load eligible issue queue", body: "Depends on #1" },
	{ number: 3, title: "Prepare isolated worktrees", body: "Depends on #1" },
	{ number: 4, title: "Parse dependency sections", body: "Depends on #2" },
	{ number: 5, title: "Rank runnable issue waves", body: "Depends on #2" },
	{ number: 6, title: "Create branch per issue", body: "Depends on #3" },
	{ number: 7, title: "Stream agent output", body: "Depends on #3" },
	{ number: 8, title: "Detect blocked issue cycles", body: "Depends on #4" },
	{ number: 9, title: "Ignore out-of-scope deps", body: "Depends on #4" },
	{ number: 10, title: "Limit parallel agent count", body: "Depends on #5" },
	{ number: 11, title: "Show execution plan tree", body: "Depends on #5" },
	{ number: 12, title: "Resume existing worktrees", body: "Depends on #6" },
	{ number: 13, title: "Clean successful worktrees", body: "Depends on #6" },
	{ number: 14, title: "Capture failed run reason", body: "Depends on #7" },
	{ number: 15, title: "Leave failed branch intact", body: "Depends on #7" },
	{ number: 16, title: "Add cycle regression test", body: "Depends on #8" },
	{ number: 17, title: "Document dependency syntax", body: "Depends on #8" },
	{ number: 18, title: "Cover external dependency", body: "Depends on #9" },
	{ number: 19, title: "Print skipped issue note", body: "Depends on #9" },
	{ number: 20, title: "Queue next ready issue", body: "Depends on #10" },
	{ number: 21, title: "Throttle agent subprocesses", body: "Depends on #10" },
	{ number: 22, title: "Align ASCII tree output", body: "Depends on #11" },
	{ number: 23, title: "Add local tree demo", body: "Depends on #11" },
	{ number: 24, title: "Reuse committed branches", body: "Depends on #12" },
	{ number: 25, title: "Skip already merged work", body: "Depends on #12" },
	{ number: 26, title: "Report cleanup failures", body: "Depends on #13" },
]

mkdirSync(binDir, { recursive: true })
writeFileSync(
	fakeGh,
	`#!/bin/sh
if [ "$1 $2" = "issue list" ]; then
	cat <<'JSON'
${JSON.stringify(issues)}
JSON
	exit 0
fi
echo "unexpected gh command: $*" >&2
exit 1
`,
)
chmodSync(fakeGh, 0o755)

const result = spawnSync(process.execPath, [cliPath, "--dry-run"], {
	cwd: workspace,
	env: {
		...process.env,
		PATH: `${binDir}:${process.env.PATH}`,
	},
	encoding: "utf8",
})

if (result.status !== 0) {
	process.stderr.write(result.stderr)
	process.stderr.write(result.stdout)
	process.exit(result.status ?? 1)
}

process.stdout.write(result.stdout.replace(/^\[[^\]]+\] /gm, ""))
