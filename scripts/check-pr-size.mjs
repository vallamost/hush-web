#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const DEFAULT_CONFIG_PATH = ".github/pr-size-allowlist.json"
const CODE_FILE_PATTERN = /\.(jsx?|tsx?)$/

function readConfig() {
  const configPath = process.env.PR_SIZE_CONFIG ?? DEFAULT_CONFIG_PATH
  const raw = fs.readFileSync(configPath, "utf8")
  return JSON.parse(raw)
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim()
}

function getDiffRange() {
  const base = process.env.PR_SIZE_BASE_REF
  const head = process.env.PR_SIZE_HEAD_REF ?? "HEAD"
  if (base) return `${base}...${head}`

  const githubBase = process.env.GITHUB_BASE_REF
  if (githubBase) return `origin/${githubBase}...${head}`

  return `origin/main...${head}`
}

function listChangedFiles(diffRange) {
  const output = git(["diff", "--name-only", diffRange])
  return output ? output.split("\n").filter(Boolean) : []
}

function listTrackedCodeFiles() {
  const output = git(["ls-files"])
  return output
    ? output.split("\n").filter((file) => CODE_FILE_PATTERN.test(file))
    : []
}

function countLines(file) {
  const text = fs.readFileSync(file, "utf8")
  if (text.length === 0) return 0
  return text.endsWith("\n") ? text.split("\n").length - 1 : text.split("\n").length
}

function fail(message, details = []) {
  console.error(message)
  for (const detail of details) console.error(`  - ${detail}`)
  process.exitCode = 1
}

function main() {
  const config = readConfig()
  const maxFiles = Number(process.env.PR_SIZE_MAX_FILES ?? config.maxFilesPerPullRequest)
  const maxLines = Number(process.env.PR_SIZE_MAX_LINES ?? config.maxLinesPerFile)
  const oversizedAllowlist = config.oversizedFiles ?? {}
  const diffRange = getDiffRange()

  const changedFiles = listChangedFiles(diffRange)
  if (changedFiles.length > maxFiles) {
    fail(
      `Pull request changes ${changedFiles.length} files; limit is ${maxFiles}.`,
      [
        "Split unrelated work into smaller PRs.",
        "If this is intentional, update maxFilesPerPullRequest in the checked-in config with reviewer approval.",
      ]
    )
  }

  const changedCodeFiles = changedFiles.filter((file) => CODE_FILE_PATTERN.test(file))
  if (changedCodeFiles.length === 0) {
    console.log(
      `Code size guard skipped: ${changedFiles.length}/${maxFiles} changed files, no code files changed.`
    )
    return
  }

  const violations = []
  for (const file of listTrackedCodeFiles()) {
    if (!fs.existsSync(path.resolve(file))) continue

    const lines = countLines(file)
    if (lines <= maxLines) continue

    const allowedLines = oversizedAllowlist[file]
    if (typeof allowedLines !== "number") {
      violations.push(`${file}: ${lines} lines, limit is ${maxLines}`)
      continue
    }

    if (lines > allowedLines) {
      violations.push(
        `${file}: ${lines} lines, allowlisted ceiling is ${allowedLines}`
      )
    }
  }

  const staleAllowlistEntries = Object.keys(oversizedAllowlist).filter(
    (file) => !fs.existsSync(path.resolve(file))
  )
  if (staleAllowlistEntries.length > 0) {
    violations.push(
      ...staleAllowlistEntries.map((file) => `${file}: allowlist entry is stale`)
    )
  }

  if (violations.length > 0) {
    fail("Code size guard failed.", violations)
    return
  }

  console.log(
    `Code size guard passed: ${changedFiles.length}/${maxFiles} changed files, ` +
      `max ${maxLines} lines for new or growing code files.`
  )
}

main()
