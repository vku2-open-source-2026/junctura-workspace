// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Early CI guard `check:neutral` (issue #14): the Workspace portal is
// sector-neutral — every industry label, record type, workflow and role group
// arrives at runtime from the installed pack's projection (GET /api/pack), so
// the runtime code of this repository must not hardcode sector vocabulary,
// data or configuration, and must not import the Health source checkout, the
// old Health package names or the retired demo/seed modules.
//
// This is a calibrated line scan of the runtime scope, not general program
// analysis. Permitted content stays outside the scope: pack fixtures
// (examples/packs/), tests, and the operator/compatibility pieces listed with
// a reason in scripts/sector-neutral-allowlist.json (registered OIDC client
// ids of the demo stack, the default fixture pack directory, the board
// privilege of issue #9, the break-glass access-review label). An allowlist
// entry suppresses only its exact path and term and is reported when stale.
//
// The scope is the shared runtime modules (app/src/, packages/ui/src/ and the
// server's JS/TS modules at every nesting level, its tests excluded), the
// shipped HTML shell and runtime-config template, and the shipped build
// config entry points that decide what actually gets bundled (the vite and
// tsconfig files). In the build config entry points every quoted string is
// treated as a potential module path/alias, because there an alias
// assignment such as `const alias = "../.junctura-health/ui"` re-introduces
// the Health checkout without any import statement.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const allowlistPath = "scripts/sector-neutral-allowlist.json";

// Runtime scope: the frontend sources, the shared UI library, the backend
// modules (server/*.mjs, not its tests) and the shipped HTML shell/config
// template. Infra (Dockerfile, compose, Caddyfile), docs, examples, tests and
// operator tooling (scripts/) are out of scope on purpose.
const runtimePrefixes = ["app/src/", "packages/ui/src/", "server/"];
const excludedPrefixes = ["app/tests/", "packages/ui/tests/", "server/tests/"];
const scopedFiles = new Set(["app/index.html", "app/public/config.example.json"]);
// Shipped build config entry points: they resolve the module graph of the
// bundle, so a Health/demo path or alias there ships sector data. Their
// quoted strings are checked as dependency paths, not only import statements.
const configEntryFiles = new Set([
  "app/vite.config.ts",
  "packages/ui/vite.config.ts",
  "app/tsconfig.json",
  "packages/ui/tsconfig.json",
  "packages/ui/tsconfig.build.json",
]);
const excludedFiles = new Set(["scripts/check-sector-neutral.mjs", allowlistPath]);

/** Sector vocabulary (health and education, Vietnamese and English) that packs carry, never this code. */
const terms = [
  "y tế", "bệnh viện", "bệnh nhân", "người bệnh", "bác sĩ", "đơn thuốc", "nhà thuốc", "phòng khám",
  "trạm y tế", "cấp cứu", "điều trị", "chẩn đoán", "phẫu thuật", "nội trú", "ngoại trú", "lâm sàng",
  "hồ sơ bệnh án", "dị ứng", "tiêm chủng", "xét nghiệm", "bảo hiểm y tế", "so-y-te", "ban-tin",
  "giáo dục", "học sinh", "sinh viên", "giáo viên", "giảng viên", "học phí", "học bổng", "bảng điểm",
  "lịch thi", "ký túc xá", "đào tạo", "trường học",
  "health", "education", "patient", "prescription", "pharmacy", "hospital", "clinic", "allergy",
  "insurance", "student", "tuition", "scholarship", "transcript", "school", "teacher",
];

/** Module specifiers that runtime code must never import (tests and fixtures are out of scope). */
const forbiddenSpecifiers = [
  { match: /junctura-health/i, reason: "the Junctura Health checkout is a CI input for the pinned pack check, never a runtime dependency" },
  { match: /^@junctura\/health/i, reason: "the shared UI library is @junctura/ui; the old Health package names are retired" },
  { match: /^@(?:demo|health|seed)\//, reason: "the old demo aliases are retired; the portal imports @junctura/ui and its own modules" },
  { match: /(?:^|[/\\])(?:demo|seed|health)[/\\]/, reason: "runtime code must not reach into demo/seed/Health source trees or statically import pack fixtures; sector data arrives at runtime from the pack projection" },
];

const patterns = terms.map((term) => {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const end = /^[\x00-\x7f]+$/u.test(term) ? "" : "(?![\\p{L}\\p{N}])";
  return { term, pattern: new RegExp(`(?<![\\p{L}\\p{N}])${escaped}${end}`, "iu") };
});

/** Module specifiers quoted on one line: `from "x"`, `import "x"`, `import("x")`, `require("x")`. */
function specifiersOn(line) {
  const found = [];
  for (const match of line.matchAll(/(?:\bfrom|\bimport|\brequire)\s*\(?\s*(?:"([^"\n]+)"|'([^'\n]+)'|`([^`$]+)`)/gu)) {
    found.push(match[1] ?? match[2] ?? match[3]);
  }
  return found;
}

/** Strings quoted on one line, backticks without interpolation included. */
function stringsOn(line) {
  const found = [];
  for (const match of line.matchAll(/"([^"\n]+)"|'([^'\n]+)'|`([^`$]+)`/gu)) {
    found.push(match[1] ?? match[2] ?? match[3]);
  }
  return found;
}

function inScope(path) {
  if (excludedFiles.has(path)) return false;
  if (path.includes("node_modules/")) return false;
  if (excludedPrefixes.some((prefix) => path.startsWith(prefix))) return false;
  if (path.includes(".test.") || path.includes(".spec.")) return false;
  if (scopedFiles.has(path) || configEntryFiles.has(path)) return true;
  if (!runtimePrefixes.some((prefix) => path.startsWith(prefix))) return false;
  // server/: its JS/TS modules at every nesting level — the subtree is
  // otherwise tests or non-runtime tooling, which the exclusions cover.
  return !path.startsWith("server/") || /\.(?:[mc]?js|jsx|ts|tsx)$/u.test(path);
}

// read(path) supplies a string or Buffer. The result contains structured
// violations and a count of scanned runtime files; importing this module runs no IO.
export function findViolations({ files, read, allowlist = [] }) {
  if (!Array.isArray(allowlist) || allowlist.some((entry) =>
    !entry || ["path", "term", "reason"].some((key) => typeof entry[key] !== "string" || !entry[key].trim()))) {
    throw new TypeError("allowlist must be an array of entries with non-empty path, term and reason strings");
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
      for (const { term, pattern } of patterns) {
        if (!pattern.test(line)) continue;
        let suppressed = false;
        for (const [entryIndex, entry] of allowlist.entries()) {
          if (entry.path === path && entry.term.toLocaleLowerCase("vi") === term.toLocaleLowerCase("vi")) {
            used.add(entryIndex);
            suppressed = true;
          }
        }
        if (!suppressed) violations.push({ path, line: index + 1, term });
      }
      for (const specifier of specifiersOn(line)) {
        for (const { match, reason } of forbiddenSpecifiers) {
          if (match.test(specifier)) violations.push({ path, line: index + 1, message: `import "${specifier}": ${reason}` });
        }
      }
      if (configEntryFiles.has(path)) {
        for (const literal of stringsOn(line)) {
          for (const { match, reason } of forbiddenSpecifiers) {
            if (match.test(literal)) violations.push({ path, line: index + 1, message: `dependency "${literal}": ${reason}` });
          }
        }
      }
    }
  }
  for (const [index, entry] of allowlist.entries()) {
    if (!used.has(index)) {
      violations.push({ path: allowlistPath, message: `unused allowlist entry: ${entry.path}: ${entry.term}` });
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
        : `${violation.path}:${violation.line}: ${violation.term ?? violation.message}`);
    }
    if (violations.length) {
      console.log(`Sector-neutral check failed: ${violations.length} violations in ${scanned} runtime files scanned`);
      return 1;
    }
    console.log(`Sector-neutral check passed: ${scanned} runtime files scanned`);
    return 0;
  } catch (error) {
    console.error(`Sector-neutral check failed: ${error.message}`);
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
