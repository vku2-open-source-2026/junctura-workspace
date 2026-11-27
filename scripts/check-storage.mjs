// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Early CI guard `check:storage` (issue #14): the portal backend keeps every
// business record on Layer 1 through the `@junctura/server-client` SDK
// (server/store.mjs). The runtime code of this repository must not persist
// business data in SQLite, must not write arbitrary host files, must not read
// seed fixtures in production and must not reach into a sibling checkout's
// `.env` — configuration comes from the process environment (docs/PORTAL.md).
//
// Like `check:neutral` this is a calibrated line scan of the runtime scope,
// not general program analysis — app/src/, packages/ui/src/ and the server's
// JS/TS modules at every nesting level, plus the shipped HTML shell and
// runtime-config template; tests, pack fixtures and operator tooling stay
// out. Preserved on purpose: reads of canonical pack configuration and BPMN
// (server/packs.mjs), the established browser session token/preference
// storage (localStorage/sessionStorage are not host writes) and non-runtime
// tooling such as scripts and tests.
//
// Two shapes are recognised narrowly, with no program analysis:
// - Host writes are permitted only when every write call on the line writes
//   directly into a `join((os.)tmpdir(), …)` of simple relative literals
//   ("preview.txt"), the ordinary temp-file pattern of issue #14; a `..`
//   segment or a separator inside such a literal keeps the line a violation.
// - A `.env` read is permitted only for the workspace's own local config:
//   every `.env` literal on the line must be the bare relative `.env` or
//   `.env.example` and no `..` segment may appear in a literal on the line.
//   Sibling-checkout or absolute `.env` paths (`../../other/.env`,
//   `join("..", "other-repo", ".env")`, `https://…/.env`) stay violations.
//
// The allowlist is the last resort and stays deliberately narrow: a
// `file-write` entry must carry a `line` substring matching the exact
// offending statement, so one exception can never hide a new arbitrary host
// write elsewhere in the same module.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowlistPath = "scripts/storage-allowlist.json";

// Same runtime scope as check:neutral.
const runtimePrefixes = ["app/src/", "packages/ui/src/", "server/"];
const excludedPrefixes = ["app/tests/", "packages/ui/tests/", "server/tests/"];
const scopedFiles = new Set(["app/index.html", "app/public/config.example.json"]);
const excludedFiles = new Set(["scripts/check-storage.mjs", allowlistPath]);

/**
 * Storage rules. `pattern` matches a line; `stringPattern` matches inside a
 * quoted string of the line; an optional `exempt(line, literals)` recognises
 * the narrow legitimate shapes described in the header. Diagnostics name the
 * rule and the concrete hit.
 */
const rules = [
  {
    rule: "sqlite",
    pattern: /\bnode:sqlite\b|\bDatabaseSync\b|\bbetter-sqlite3\b|["'`]sqlite3?["'`]|\bsql\.js\b/i,
    message: "runtime business persistence in SQLite; records belong on Layer 1 through the backend SDK",
  },
  {
    rule: "file-write",
    pattern: /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\b/i,
    exempt: tempSafeWrite,
    message: "runtime write to a host file; business bytes belong on Layer 1 (only a direct write into join((os.)tmpdir(), …) of simple relative literals is recognized)",
  },
  {
    rule: "seed-read",
    stringPattern: /(?:^|[/\\])seed(?:$|[/\\])/u,
    message: "production read of seed fixtures; the backend serves the installed pack and Layer 1 data only",
  },
  {
    rule: "env-read",
    stringPattern: /(?:^|[/\\])\.env(?:$|[./\\])/u,
    exempt: (line, literals) => {
      const envLiterals = literals.filter((literal) => /(?:^|[/\\])\.env(?:$|[./\\])/u.test(literal));
      return envLiterals.length > 0
        && envLiterals.every((literal) => /^\.env(?:\.example)?$/u.test(literal))
        && !literals.some((literal) => /(?:^|[/\\])\.\.(?:[\\/]|$)/u.test(literal));
    },
    message: "runtime read of a .env file outside the workspace's own local config (a sibling checkout's or otherwise); configuration comes from the process environment",
  },
];

/** Strings quoted on one line, backticks without interpolation included. */
function stringsOn(line) {
  const found = [];
  for (const match of line.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`$]+)`/gu)) {
    found.push(match[1] ?? match[2] ?? match[3]);
  }
  return found;
}

const writeCall = /\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\s*\(/gu;
const tempJoinArgs = /^\s*(?:path\.)?join\(\s*(?:os\.)?tmpdir\(\)\s*((?:,\s*(?:"[^"\n]*"|'[^'\n]*'))*)\s*\)/u;

/**
 * True when every write call on the line writes directly into a tmpdir join
 * whose remaining arguments are simple relative literals: no separators, no
 * `..`, no empty or `.` names. Anything else — a variable target, a joined
 * `..` escape, an absolute name — stays a violation.
 */
function tempSafeWrite(line) {
  const calls = [...line.matchAll(writeCall)];
  if (!calls.length) return false;
  return calls.every((call) => {
    const args = line.slice(call.index + call[0].length).match(tempJoinArgs);
    if (!args) return false;
    const literals = (args[1] ?? "").match(/"(?:[^"\\]*)"|'(?:[^'\\]*)'/gu) ?? [];
    return literals.length > 0 && literals.every((literal) => {
      const name = literal.slice(1, -1);
      return name !== "." && !name.includes("..") && !name.includes("/") && !name.includes("\\");
    });
  });
}

function inScope(path) {
  if (excludedFiles.has(path)) return false;
  if (path.includes("node_modules/")) return false;
  if (excludedPrefixes.some((prefix) => path.startsWith(prefix))) return false;
  if (path.includes(".test.") || path.includes(".spec.")) return false;
  if (scopedFiles.has(path)) return true;
  if (!runtimePrefixes.some((prefix) => path.startsWith(prefix))) return false;
  // server/: its JS/TS modules at every nesting level — the subtree is
  // otherwise tests or non-runtime tooling, which the exclusions cover.
  return !path.startsWith("server/") || /\.(?:[mc]?js|jsx|ts|tsx)$/u.test(path);
}

// read(path) supplies a string or Buffer. The result contains structured
// violations and a count of scanned runtime files; importing this module runs no IO.
export function findViolations({ files, read, allowlist = [] }) {
  if (!Array.isArray(allowlist) || allowlist.some((entry) => {
    if (!entry) return true;
    if (["path", "rule", "reason"].some((key) => typeof entry[key] !== "string" || !entry[key].trim())) return true;
    if (entry.line !== undefined && (typeof entry.line !== "string" || !entry.line.trim())) return true;
    // A file-write exception must name its exact statement, so one entry can
    // never hide a new arbitrary host write elsewhere in the same module.
    return entry.rule === "file-write" && (entry.line === undefined || !entry.line.trim());
  })) {
    throw new TypeError("allowlist must be an array of entries with non-empty path, rule and reason strings, and a file-write entry also needs a non-empty line substring");
  }
  const violations = [];
  const used = new Set();
  let scanned = 0;

  for (const path of [...new Set(files)].sort()) {
    if (!inScope(path)) continue;
    const bytes = Buffer.from(read(path));
    if (bytes.subarray(0, 8192).includes(0)) continue; // binary
    scanned += 1;
    const lines = bytes.toString("utf8").split(/\r\n|\n|\r/u);
    for (const [index, line] of lines.entries()) {
      const literals = stringsOn(line);
      for (const { rule, pattern, stringPattern, exempt, message } of rules) {
        const hit = stringPattern
          ? literals.some((literal) => stringPattern.test(literal))
          : pattern.test(line);
        if (!hit || (exempt && exempt(line, literals))) continue;
        let suppressed = false;
        for (const [entryIndex, entry] of allowlist.entries()) {
          if (entry.path === path && entry.rule === rule && (entry.line === undefined || line.includes(entry.line))) {
            used.add(entryIndex);
            suppressed = true;
          }
        }
        if (!suppressed) violations.push({ path, line: index + 1, rule, message });
      }
    }
  }
  for (const [index, entry] of allowlist.entries()) {
    if (!used.has(index)) {
      violations.push({ path: allowlistPath, message: `unused allowlist entry: ${entry.path}: ${entry.rule}` });
    }
  }
  return { violations, scanned };
}

/** Runs the check on the live checkout (tests inject `files`/`read`/`allowlist`) and returns the exit code. */
export function runCheck({ files, read, allowlist } = {}) {
  try {
    const { violations, scanned } = findViolations({
      files: files ?? liveFiles(),
      read: read ?? ((path) => readFileSync(join(root, path))),
      allowlist: allowlist ?? JSON.parse(readFileSync(join(root, allowlistPath), "utf8")),
    });
    for (const violation of violations) {
      console.log(violation.line === undefined
        ? `${violation.path}: ${violation.message}`
        : `${violation.path}:${violation.line}: ${violation.rule}: ${violation.message}`);
    }
    if (violations.length) {
      console.log(`Storage check failed: ${violations.length} violations in ${scanned} runtime files scanned`);
      return 1;
    }
    console.log(`Storage check passed: ${scanned} runtime files scanned`);
    return 0;
  } catch (error) {
    console.error(`Storage check failed: ${error.message}`);
    return 1;
  }
}

function liveFiles() {
  const tracked = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" });
  if (tracked.status !== 0) throw tracked.error ?? new Error(tracked.stderr.trim() || "git ls-files failed");
  return tracked.stdout.split("\0").filter((path) => path && existsSync(join(root, path)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCheck();
}
