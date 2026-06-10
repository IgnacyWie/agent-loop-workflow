import assert from "node:assert/strict"
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import test from "node:test"

const cliPath = resolve("bin/agent-loop.js")

function makeTempRepo() {
	return mkdtempSync(join(tmpdir(), "agent-loop-test-"))
}

function writeFakeGh(dir, script) {
	const binDir = join(dir, "bin")
	const ghPath = join(binDir, "gh")
	mkdirSync(binDir, { recursive: true })
	writeFileSync(ghPath, script)
	chmodSync(ghPath, 0o755)
	return binDir
}

function runCli(cwd, binDir, args) {
	return spawnSync(process.execPath, [cliPath, ...args], {
		cwd,
		env: {
			...process.env,
			PATH: `${binDir}:${process.env.PATH}`,
		},
		encoding: "utf8",
	})
}

test("dry run prints execution waves and dependency tree", () => {
	const cwd = makeTempRepo()
	const issues = [
		{ number: 1, title: "Prepare base", body: "" },
		{ number: 2, title: "Build API", body: "Depends on #1" },
		{ number: 3, title: "Build UI", body: "Blocked by #1" },
		{ number: 4, title: "Wire product", body: "## Depends on\n\n- #2\n- #3" },
		{ number: 5, title: "Standalone cleanup", body: "Depends on #999" },
	]
	const binDir = writeFakeGh(
		cwd,
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

	const result = runCli(cwd, binDir, ["--dry-run"])

	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /Found 5 eligible issue\(s\)\./)
	assert.match(result.stdout, /Wave 1: #1 Prepare base \| #5 Standalone cleanup/)
	assert.match(result.stdout, /Wave 2: #2 Build API \| #3 Build UI/)
	assert.match(result.stdout, /Wave 3: #4 Wire product/)
	assert.match(result.stdout, /Dependency tree:/)
	assert.match(result.stdout, /#1 Prepare base/)
	assert.match(result.stdout, /\|-- #1 Prepare base/)
	assert.match(result.stdout, /\|   \|-- #2 Build API/)
	assert.match(result.stdout, /`-- #5 Standalone cleanup/)
	assert.match(result.stdout, /Dry run complete\./)
	assert.deepEqual(
		readdirSync(cwd).filter((name) => /^agent-loop-.*\.log$/.test(name)),
		[],
	)
})

test("help documents tmux mode", () => {
	const cwd = makeTempRepo()
	const result = runCli(cwd, cwd, ["--help"])

	assert.equal(result.status, 0, result.stderr)
	assert.match(result.stdout, /--tmux\s+Run agents in tmux with one window per wave/)
	assert.match(result.stdout, /--no-tmux-attach\s+Do not automatically attach/)
})

test("setup labels creates the required labels and in-progress label", () => {
	const cwd = makeTempRepo()
	const callsPath = join(cwd, "gh-calls")
	const binDir = writeFakeGh(
		cwd,
		`#!/bin/sh
echo "$*" >> "${callsPath}"
exit 0
`,
	)

	const result = runCli(cwd, binDir, ["--setup-labels"])
	const calls = readFileSync(callsPath, "utf8")

	assert.equal(result.status, 0, result.stderr)
	assert.match(calls, /label create ready-for-agent --color 0E8A16/)
	assert.match(calls, /label create automated-agent --color 5319E7/)
	assert.match(calls, /label create aa-in-progress --color FBCA04/)
	assert.match(result.stdout, /Label setup complete\./)
})
