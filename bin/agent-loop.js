#!/usr/bin/env node

import { appendFileSync, existsSync, mkdirSync } from "node:fs"
import { basename, resolve } from "node:path"
import { spawn } from "node:child_process"
import process from "node:process"

const DEFAULT_LABELS = ["ready-for-agent", "automated-agent"]
const DEFAULT_IN_PROGRESS_LABEL = "aa-in-progress"
const READY_LABEL_COLOR = "0E8A16"
const AUTOMATED_LABEL_COLOR = "5319E7"
const CUSTOM_LABEL_COLOR = "1D76DB"
const IN_PROGRESS_LABEL_COLOR = "FBCA04"
const SUPPORTED_AGENTS = ["codex", "claude"]
const MAX_PARALLEL = 5
const LOG_FILE = `agent-loop-${new Date().toISOString().replace(/[:.]/g, "-")}.log`

const INLINE_DEPENDENCY_PATTERNS = [
	/\bdepends?\s+on\s+#(\d+)/gi,
	/\bblocked?\s+by\s+#(\d+)/gi,
	/\brequires?\s+#(\d+)/gi,
	/\bprerequisites?\s*[:#]\s*#(\d+)/gi,
]

const SECTION_DEPENDENCY_PATTERN =
	/##\s*(?:blocked?\s+by|parent|depends?\s+on|prerequisites?|requires?)\b[^\n]*\n([\s\S]*?)(?=\n##|$)/gi

function log(message) {
	const line = `[${new Date().toISOString()}] ${message}`
	console.log(line)
	appendFileSync(LOG_FILE, `${line}\n`)
}

function readFlag(name) {
	const prefix = `${name}=`
	const valueFromEquals = process.argv.find((arg) => arg.startsWith(prefix))
	if (valueFromEquals) return valueFromEquals.slice(prefix.length)

	const index = process.argv.indexOf(name)
	if (index !== -1) return process.argv[index + 1]

	return undefined
}

function hasFlag(name) {
	return process.argv.includes(name)
}

function printHelp() {
	console.log(`agent-loop

Run labeled GitHub issues through coding agents in isolated git worktrees.

Usage:
  agent-loop [options]

Options:
  --agent <codex|claude>       Agent CLI to run. Default: codex
  --parallel <n>               Max parallel agents. Default: 5, max: 5
  --labels <a,b>               Required issue labels. Default: ready-for-agent,automated-agent
  --in-progress-label <label>  Label added while an issue is running. Default: aa-in-progress
  --worktree-dir <path>        Directory for git worktrees. Default: .agent-worktrees
  --base-branch <branch>       Branch used for new worktrees. Default: current branch
  --repo-name <name>           Repository name used in prompts. Default: current directory
  --setup-labels               Create or update required GitHub issue labels, then exit
  --dry-run                    Print execution waves without running agents
  --no-close                   Do not close GitHub issues after successful merge
  --help                       Show this help
`)
}

function parseConfig() {
	if (hasFlag("--help") || hasFlag("-h")) {
		printHelp()
		process.exit(0)
	}

	const agent = readFlag("--agent") ?? process.env.AGENT_LOOP_AGENT ?? "codex"
	if (!SUPPORTED_AGENTS.includes(agent)) {
		throw new Error(
			`Unsupported agent "${agent}". Expected one of: ${SUPPORTED_AGENTS.join(", ")}`,
		)
	}

	const parallelRaw =
		readFlag("--parallel") ?? process.env.AGENT_LOOP_PARALLEL ?? "5"
	const parallel = Number(parallelRaw)
	if (!Number.isInteger(parallel) || parallel < 1) {
		throw new Error(
			`Invalid --parallel value "${parallelRaw}". Expected an integer >= 1.`,
		)
	}
	if (parallel > MAX_PARALLEL) {
		throw new Error(`--parallel cannot exceed ${MAX_PARALLEL}.`)
	}

	const labelsRaw =
		readFlag("--labels") ?? process.env.AGENT_LOOP_LABELS ?? DEFAULT_LABELS.join(",")
	const labels = labelsRaw
		.split(",")
		.map((label) => label.trim())
		.filter(Boolean)
	if (labels.length === 0) {
		throw new Error("--labels must include at least one label.")
	}

	const noClose =
		hasFlag("--no-close") ||
		process.env.AGENT_LOOP_NO_CLOSE === "1" ||
		process.env.AGENT_LOOP_NO_CLOSE === "true"

	return {
		agent,
		parallel,
		labels,
		inProgressLabel:
			readFlag("--in-progress-label") ??
			process.env.AGENT_LOOP_IN_PROGRESS_LABEL ??
			DEFAULT_IN_PROGRESS_LABEL,
		worktreeDir: resolve(
			readFlag("--worktree-dir") ??
				process.env.AGENT_LOOP_WORKTREE_DIR ??
				".agent-worktrees",
		),
		baseBranch: readFlag("--base-branch") ?? process.env.AGENT_LOOP_BASE_BRANCH,
		repoName:
			readFlag("--repo-name") ??
			process.env.AGENT_LOOP_REPO_NAME ??
			basename(process.cwd()),
		setupLabels: hasFlag("--setup-labels"),
		dryRun: hasFlag("--dry-run"),
		noClose,
	}
}

function parseDependencies(body) {
	const deps = new Set()

	for (const pattern of INLINE_DEPENDENCY_PATTERNS) {
		pattern.lastIndex = 0
		let match = pattern.exec(body)
		while (match !== null) {
			deps.add(Number(match[1]))
			match = pattern.exec(body)
		}
	}

	SECTION_DEPENDENCY_PATTERN.lastIndex = 0
	let sectionMatch = SECTION_DEPENDENCY_PATTERN.exec(body)
	while (sectionMatch !== null) {
		const refPattern = /#(\d+)/g
		let refMatch = refPattern.exec(sectionMatch[1])
		while (refMatch !== null) {
			deps.add(Number(refMatch[1]))
			refMatch = refPattern.exec(sectionMatch[1])
		}
		sectionMatch = SECTION_DEPENDENCY_PATTERN.exec(body)
	}

	return [...deps]
}

function buildDependencyMap(issues) {
	const inScope = new Set(issues.map((issue) => issue.number))
	return new Map(
		issues.map((issue) => [
			issue.number,
			parseDependencies(issue.body ?? "").filter((dep) => inScope.has(dep)),
		]),
	)
}

function topologicalSort(issues) {
	const issueMap = new Map(issues.map((issue) => [issue.number, issue]))
	const deps = buildDependencyMap(issues)
	const visited = new Set()
	const visiting = new Set()
	const result = []

	function visit(number) {
		if (visited.has(number)) return
		if (visiting.has(number)) {
			throw new Error(`Dependency cycle detected at issue #${number}.`)
		}

		visiting.add(number)
		for (const dep of deps.get(number) ?? []) {
			visit(dep)
		}
		visiting.delete(number)
		visited.add(number)

		const issue = issueMap.get(number)
		if (issue) result.push(issue)
	}

	for (const issue of issues) {
		visit(issue.number)
	}

	return result
}

function buildExecutionWaves(issues) {
	const remaining = new Map(issues.map((issue) => [issue.number, issue]))
	const done = new Set()
	const deps = buildDependencyMap(issues)
	const waves = []

	while (remaining.size > 0) {
		const ready = [...remaining.values()].filter((issue) =>
			(deps.get(issue.number) ?? []).every((dep) => done.has(dep)),
		)

		if (ready.length === 0) {
			throw new Error("Cannot build execution waves. Check for dependency cycles.")
		}

		waves.push(ready)
		for (const issue of ready) {
			remaining.delete(issue.number)
			done.add(issue.number)
		}
	}

	return waves
}

async function runCommand(command, options = {}) {
	return await new Promise((resolvePromise) => {
		const proc = spawn(command[0], command.slice(1), {
			cwd: options.cwd,
			stdio: ["ignore", "pipe", "pipe"],
		})
		let stdout = ""
		let stderr = ""

		proc.stdout.on("data", (chunk) => {
			const text = chunk.toString()
			stdout += text
			if (options.streamToLog) appendFileSync(LOG_FILE, text)
		})

		proc.stderr.on("data", (chunk) => {
			const text = chunk.toString()
			stderr += text
			if (options.streamToLog) appendFileSync(LOG_FILE, text)
		})

		proc.on("error", (error) => {
			resolvePromise({ exitCode: 127, stdout, stderr: String(error) })
		})

		proc.on("close", (exitCode) => {
			resolvePromise({ exitCode: exitCode ?? 1, stdout, stderr })
		})
	})
}

async function runRequiredCommand(command, cwd) {
	const result = await runCommand(command, { cwd })
	if (result.exitCode !== 0) {
		throw new Error(
			`${command.join(" ")} failed with code ${result.exitCode}: ${
				result.stderr || result.stdout
			}`,
		)
	}
	return result
}

async function fetchEligibleIssues(labels) {
	const command = [
		"gh",
		"issue",
		"list",
		"--state",
		"open",
		"--json",
		"number,title,body,labels",
		"--limit",
		"100",
	]

	for (const label of labels) {
		command.push("--label", label)
	}

	const result = await runCommand(command)
	if (result.exitCode !== 0) {
		throw new Error(`gh issue list failed: ${result.stderr || result.stdout}`)
	}

	return JSON.parse(result.stdout)
}

function labelConfig(label, inProgressLabel) {
	if (label === inProgressLabel) {
		return {
			color: IN_PROGRESS_LABEL_COLOR,
			description: "Automated agent is working on this issue",
		}
	}
	if (label === "ready-for-agent") {
		return {
			color: READY_LABEL_COLOR,
			description: "Issue is ready for an automated coding agent",
		}
	}
	if (label === "automated-agent") {
		return {
			color: AUTOMATED_LABEL_COLOR,
			description: "Issue can be processed by agent-loop",
		}
	}
	return {
		color: CUSTOM_LABEL_COLOR,
		description: "Issue label used by agent-loop",
	}
}

async function ensureLabelExists(label, config) {
	const labelDetails = labelConfig(label, config.inProgressLabel)
	const createResult = await runCommand([
		"gh",
		"label",
		"create",
		label,
		"--color",
		labelDetails.color,
		"--description",
		labelDetails.description,
	])

	if (createResult.exitCode === 0) return

	const editResult = await runCommand([
		"gh",
		"label",
		"edit",
		label,
		"--color",
		labelDetails.color,
		"--description",
		labelDetails.description,
	])

	if (editResult.exitCode !== 0) {
		throw new Error(
			`Failed to ensure ${label} label exists: ${
				editResult.stderr ||
				editResult.stdout ||
				createResult.stderr ||
				createResult.stdout
			}`,
		)
	}
}

async function setupLabels(config) {
	for (const label of [...new Set([...config.labels, config.inProgressLabel])]) {
		await ensureLabelExists(label, config)
		log(`LABEL ${label}: ready`)
	}
}

async function ensureInProgressLabelExists(label) {
	await ensureLabelExists(label, { inProgressLabel: label })
}

async function labelIssueInProgress(issue, label) {
	await ensureInProgressLabelExists(label)
	await runRequiredCommand([
		"gh",
		"issue",
		"edit",
		String(issue.number),
		"--add-label",
		label,
	])
}

async function getCurrentBranch() {
	const result = await runRequiredCommand(["git", "branch", "--show-current"])
	const branch = result.stdout.trim()
	if (!branch) {
		throw new Error("Cannot run agent loop from a detached HEAD checkout.")
	}
	return branch
}

async function assertCleanWorktree() {
	const result = await runRequiredCommand(["git", "status", "--porcelain"])
	if (result.stdout.trim()) {
		throw new Error(
			"Main worktree has uncommitted changes. Commit, stash, or run --dry-run before automated merging.",
		)
	}
}

function branchNameForIssue(issue) {
	return `agent/issue-${issue.number}`
}

function worktreePathForIssue(worktreeDir, issue) {
	return resolve(worktreeDir, `issue-${issue.number}`)
}

async function branchExists(branchName) {
	const result = await runCommand(["git", "rev-parse", "--verify", branchName])
	return result.exitCode === 0
}

async function getRegisteredWorktreePathForBranch(branchName) {
	const result = await runRequiredCommand(["git", "worktree", "list", "--porcelain"])
	let currentPath

	for (const line of result.stdout.split("\n")) {
		if (line.startsWith("worktree ")) {
			currentPath = line.slice("worktree ".length)
			continue
		}
		if (line === `branch refs/heads/${branchName}`) {
			return currentPath
		}
	}

	return undefined
}

async function getWorktreeBranch(worktreePath) {
	const result = await runCommand(["git", "branch", "--show-current"], {
		cwd: worktreePath,
	})
	if (result.exitCode !== 0) return undefined
	return result.stdout.trim() || undefined
}

async function isWorktreeClean(worktreePath) {
	const result = await runRequiredCommand(["git", "status", "--porcelain"], worktreePath)
	return !result.stdout.trim()
}

async function branchDiffersFromHead(branchName) {
	const result = await runCommand(["git", "diff", "--quiet", "HEAD", branchName])
	if (result.exitCode === 0) return false
	if (result.exitCode === 1) return true
	throw new Error(
		`git diff failed for ${branchName}: ${result.stderr || result.stdout}`,
	)
}

async function branchMergedIntoHead(branchName) {
	const result = await runCommand([
		"git",
		"merge-base",
		"--is-ancestor",
		branchName,
		"HEAD",
	])
	return result.exitCode === 0
}

async function removeIssueWorktreeIfPresent(worktreePath) {
	if (!existsSync(worktreePath)) return
	await runRequiredCommand(["git", "worktree", "remove", worktreePath])
}

async function ensureIssueWorktree(issue, baseBranch, worktreeDir) {
	const branchName = branchNameForIssue(issue)
	const worktreePath = worktreePathForIssue(worktreeDir, issue)
	const hasBranch = await branchExists(branchName)
	const registeredWorktreePath = hasBranch
		? await getRegisteredWorktreePathForBranch(branchName)
		: undefined

	if (registeredWorktreePath) {
		return { branchName, worktreePath: registeredWorktreePath, resumed: true }
	}

	if (existsSync(worktreePath)) {
		const worktreeBranch = await getWorktreeBranch(worktreePath)
		if (worktreeBranch === branchName) {
			return { branchName, worktreePath, resumed: true }
		}
		throw new Error(
			`Worktree path already exists for a different checkout: ${worktreePath}`,
		)
	}

	mkdirSync(worktreeDir, { recursive: true })
	if (hasBranch) {
		await runRequiredCommand(["git", "worktree", "add", worktreePath, branchName])
		return { branchName, worktreePath, resumed: true }
	}

	await runRequiredCommand([
		"git",
		"worktree",
		"add",
		"-b",
		branchName,
		worktreePath,
		baseBranch,
	])

	return { branchName, worktreePath, resumed: false }
}

function buildPrompt(issue, config) {
	return [
		`You are implementing GitHub issue #${issue.number} in the ${config.repoName} repository.`,
		`You are running in an isolated git worktree for branch ${branchNameForIssue(issue)}.`,
		"",
		`Issue title: ${issue.title}`,
		"",
		"Issue body:",
		issue.body ?? "",
		"",
		"Instructions:",
		"- Read the issue body carefully and implement everything described.",
		"- Follow the repository's existing conventions and agent instructions.",
		"- Add or update focused tests for the behavior you change when the repository has a test setup.",
		`- Commit your changes with a message referencing the issue, for example: "feat: implement thing close #${issue.number}".`,
		"- Do not close or comment on the GitHub issue. The parent agent-loop process handles issue closure after merge.",
		"- If you cannot fully implement the issue, exit non-zero or leave the worktree uncommitted with notes in your final output.",
	].join("\n")
}

function buildAgentCommand(agent, prompt, worktreePath) {
	if (agent === "claude") {
		return ["claude", "--dangerously-skip-permissions", "-p", prompt]
	}

	return [
		"codex",
		"exec",
		"--dangerously-bypass-approvals-and-sandbox",
		"-C",
		worktreePath,
		prompt,
	]
}

async function runAgent(issue, baseBranch, config) {
	const { branchName, worktreePath, resumed } = await ensureIssueWorktree(
		issue,
		baseBranch,
		config.worktreeDir,
	)
	const prompt = buildPrompt(issue, config)

	log(`${"=".repeat(72)}`)
	log(
		`${resumed ? "RESUME" : "START"} #${issue.number}: ${issue.title} [${config.agent}]`,
	)
	log(`Branch: ${branchName}`)
	log(`Worktree: ${worktreePath}`)

	if (resumed && (await branchMergedIntoHead(branchName))) {
		log(`DONE  #${issue.number}: ${branchName} is already merged into HEAD`)
		return { issue, ok: true, branchName, worktreePath, alreadyMerged: true }
	}

	if (
		resumed &&
		(await isWorktreeClean(worktreePath)) &&
		(await branchDiffersFromHead(branchName))
	) {
		log(`DONE  #${issue.number}: reusing committed changes on ${branchName}`)
		return { issue, ok: true, branchName, worktreePath }
	}

	await labelIssueInProgress(issue, config.inProgressLabel)
	log(`LABEL #${issue.number}: ${config.inProgressLabel}`)
	log(`${"=".repeat(72)}`)

	const result = await runCommand(
		buildAgentCommand(config.agent, prompt, worktreePath),
		{
			cwd: worktreePath,
			streamToLog: true,
		},
	)

	if (result.exitCode === 0) {
		log(`DONE  #${issue.number}: agent exited cleanly`)
		return { issue, ok: true, branchName, worktreePath }
	}

	log(`FAIL  #${issue.number}: agent exited with code ${result.exitCode}`)
	return {
		issue,
		ok: false,
		branchName,
		worktreePath,
		error: `agent exited with code ${result.exitCode}`,
	}
}

async function closeIssue(issue) {
	await runRequiredCommand([
		"gh",
		"issue",
		"close",
		String(issue.number),
		"--comment",
		"Implemented by automated agent loop",
	])
}

async function mergeIssueResult(result, config) {
	const { issue, branchName, worktreePath } = result

	if (result.alreadyMerged || (await branchMergedIntoHead(branchName))) {
		if (!config.noClose) await closeIssue(issue)
		await removeIssueWorktreeIfPresent(worktreePath)
		log(`CLOSED #${issue.number}: already merged and removed worktree`)
		return
	}

	const diffResult = await runCommand(["git", "diff", "--quiet", "HEAD", branchName])
	if (diffResult.exitCode === 0) {
		throw new Error(
			`Branch ${branchName} has no committed changes to merge. Worktree left at ${worktreePath}.`,
		)
	}
	if (diffResult.exitCode !== 1) {
		throw new Error(
			`git diff failed for #${issue.number}: ${diffResult.stderr || diffResult.stdout}`,
		)
	}

	log(`MERGE #${issue.number}: ${branchName}`)
	const mergeResult = await runCommand([
		"git",
		"merge",
		"--no-ff",
		branchName,
		"-m",
		`merge: automated issue #${issue.number}`,
	])

	if (mergeResult.exitCode !== 0) {
		await runCommand(["git", "merge", "--abort"])
		throw new Error(
			`Merge failed for #${issue.number} (${branchName}). Worktree left at ${worktreePath}. ${
				mergeResult.stderr || mergeResult.stdout
			}`,
		)
	}

	if (!config.noClose) await closeIssue(issue)
	await removeIssueWorktreeIfPresent(worktreePath)
	log(`CLOSED #${issue.number}: merged and removed worktree`)
}

async function commentFailedIssue(result, reason) {
	await runCommand([
		"gh",
		"issue",
		"comment",
		String(result.issue.number),
		"--body",
		`Automated agent could not complete: ${reason}`,
	])
}

function readyIssues(ordered, states, deps) {
	return ordered.filter((issue) => {
		if (states.get(issue.number) !== "pending") return false
		return (deps.get(issue.number) ?? []).every(
			(dep) => states.get(dep) === "done",
		)
	})
}

function skipBlockedByFailedDependencies(ordered, states, deps) {
	for (const issue of ordered) {
		if (states.get(issue.number) !== "pending") continue

		const failedDeps = (deps.get(issue.number) ?? []).filter((dep) => {
			const state = states.get(dep)
			return state === "failed" || state === "skipped"
		})

		if (failedDeps.length > 0) {
			states.set(issue.number, "skipped")
			log(
				`SKIP  #${issue.number}: dependency failed or skipped (#${failedDeps.join(", #")})`,
			)
		}
	}
}

async function handleCompleted(completed, states, config) {
	if (!completed.result.ok) {
		states.set(completed.issueNumber, "failed")
		await commentFailedIssue(
			completed.result,
			completed.result.error ?? "agent exited non-zero; branch/worktree left for inspection",
		)
		return
	}

	try {
		await mergeIssueResult(completed.result, config)
		states.set(completed.issueNumber, "done")
	} catch (error) {
		states.set(completed.issueNumber, "failed")
		await commentFailedIssue(completed.result, String(error))
		log(`FAIL  #${completed.issueNumber}: ${error}`)
	}
}

async function runScheduler(ordered, baseBranch, config) {
	const deps = buildDependencyMap(ordered)
	const states = new Map(ordered.map((issue) => [issue.number, "pending"]))
	const running = new Map()

	while ([...states.values()].some((state) => state === "pending")) {
		skipBlockedByFailedDependencies(ordered, states, deps)

		for (const issue of readyIssues(ordered, states, deps)) {
			if (running.size >= config.parallel) break

			states.set(issue.number, "running")
			const promise = runAgent(issue, baseBranch, config)
				.then((result) => ({ issueNumber: issue.number, result }))
				.catch((error) => {
					const message = String(error)
					log(`FAIL  #${issue.number}: ${message}`)
					return {
						issueNumber: issue.number,
						result: {
							issue,
							ok: false,
							branchName: branchNameForIssue(issue),
							worktreePath: worktreePathForIssue(config.worktreeDir, issue),
							error: message,
						},
					}
				})
			running.set(issue.number, promise)
		}

		if (running.size === 0) {
			const pending = ordered
				.filter((issue) => states.get(issue.number) === "pending")
				.map((issue) => `#${issue.number}`)
				.join(", ")
			if (!pending) break
			throw new Error(`No runnable issues remain, but pending issues exist: ${pending}`)
		}

		const completed = await Promise.race(running.values())
		running.delete(completed.issueNumber)
		await handleCompleted(completed, states, config)
	}

	const runningResults = await Promise.all(running.values())
	for (const completed of runningResults) {
		await handleCompleted(completed, states, config)
	}

	return states
}

async function main() {
	const config = parseConfig()

	if (config.setupLabels) {
		await setupLabels(config)
		log("Label setup complete.")
		return
	}

	const issues = await fetchEligibleIssues(config.labels)

	if (issues.length === 0) {
		log(`No open issues found with labels: ${config.labels.join(", ")}`)
		return
	}

	const ordered = topologicalSort(issues)
	const waves = buildExecutionWaves(ordered)
	log(`Found ${issues.length} eligible issue(s).`)
	for (const [index, wave] of waves.entries()) {
		log(
			`Wave ${index + 1}: ${wave
				.map((issue) => `#${issue.number} ${issue.title}`)
				.join(" | ")}`,
		)
	}

	if (config.dryRun) {
		log("Dry run complete.")
		return
	}

	await assertCleanWorktree()
	const baseBranch = config.baseBranch ?? (await getCurrentBranch())
	const states = await runScheduler(ordered, baseBranch, config)
	const failed = [...states.entries()].filter(([, state]) =>
		["failed", "skipped"].includes(state),
	)

	if (failed.length > 0) {
		throw new Error(
			`Agent loop completed with unresolved issues: ${failed
				.map(([number, state]) => `#${number} ${state}`)
				.join(", ")}`,
		)
	}

	log("Agent loop complete.")
}

main().catch((error) => {
	log(`ERROR ${error instanceof Error ? error.message : String(error)}`)
	process.exitCode = 1
})
