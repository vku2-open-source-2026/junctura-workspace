// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Fixture regressions of `check:storage` (issue #14): each violation group and
// the legitimate cases, verified against synthetic sources so no fixture here
// depends on the live tree. One test additionally asserts that the current
// Workspace source satisfies the check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findViolations, runCheck } from "../check-storage.mjs";

const scan = (contents, allowlist = []) =>
  findViolations({ files: Object.keys(contents), read: (path) => contents[path], allowlist });

test("flags SQLite persistence in the backend and the frontend with path and line", () => {
  const { violations } = scan({
    "server/store.mjs": "import { DatabaseSync } from \"node:sqlite\";\nconst db = new DatabaseSync(\":memory:\");\n",
    "app/src/offline.ts": "import SQLite from \"better-sqlite3\";\n",
  });
  assert.deepEqual(violations.map((entry) => [entry.path, entry.line, entry.rule]), [
    ["app/src/offline.ts", 1, "sqlite"],
    ["server/store.mjs", 1, "sqlite"],
    ["server/store.mjs", 2, "sqlite"],
  ]);
  assert.match(violations[0].message, /records belong on Layer 1/u);
});

test("flags host file writes, imports included, and names the concrete write API", () => {
  const { violations } = scan({
    "server/app.mjs": "import { writeFile } from \"node:fs/promises\";\nawait writeFile(cachePath, bytes);\nconst log = createWriteStream(logPath);\n",
  });
  assert.deepEqual(violations.map((entry) => [entry.line, entry.rule]), [[1, "file-write"], [2, "file-write"], [3, "file-write"]]);
  assert.match(violations[0].message, /runtime write to a host file/u);
});

test("preserves the ordinary direct temp-file write and flags traversal out of it", () => {
  assert.deepEqual(scan({
    "app/src/preview.ts": "await writeFile(join(tmpdir(), \"preview.txt\"), bytes);\nwriteFileSync(join(os.tmpdir(), \"report.csv\"), rows);\nappendFile(join(tmpdir(), \"log\", \"app.txt\"), line);\nconst stream = createWriteStream(join(tmpdir(), \"dump.bin\"));",
    "server/export.mjs": "await writeFile(join(tmpdir(), \"preview.txt\"), bytes);",
  }).violations, []);
  for (const bad of [
    "await writeFile(join(tmpdir(), \"..\", \"escape.txt\"), bytes);",
    "writeFileSync(join(tmpdir(), \"sub/../x.txt\"), bytes);",
    "await writeFile(target, bytes);",
    "writeFile(join(tmpdir(), filename), bytes);",
    "writeFile(tmpdir() + \"/preview.txt\", bytes);",
    "await writeFile(join(tmpdir(), \"a\"), bytes); writeFileSync(other, bytes);",
  ]) {
    assert.deepEqual(scan({ "server/x.mjs": `${bad}\n` }).violations.map((entry) => entry.rule), ["file-write"], bad);
  }
});

test("flags SQLite persistence in nested server runtime modules too", () => {
  const { violations } = scan({
    "server/records/sqlite.mjs": "import { DatabaseSync } from \"node:sqlite\";\n",
    "server/tests/records/offline.test.mjs": "import { DatabaseSync } from \"node:sqlite\";\n",
  });
  assert.deepEqual(violations, [{
    path: "server/records/sqlite.mjs", line: 1, rule: "sqlite",
    message: "runtime business persistence in SQLite; records belong on Layer 1 through the backend SDK",
  }]);
});

test("preserves reads, temp-dir utilities and browser session storage", () => {
  assert.deepEqual(scan({
    "server/packs.mjs": "import { readFile, mkdtemp } from \"node:fs/promises\";\nconst manifest = JSON.parse(await readFile(packFile, \"utf8\"));\nconst tmp = await mkdtemp(prefix);",
    "app/src/session.ts": "localStorage.setItem(sessionKey, token);\nsessionStorage.setItem(prefsKey, JSON.stringify(prefs));",
    "server/main.mjs": "const juncturaUrl = process.env.JUNCTURA_URL ?? \"\";",
  }).violations, []);
});

test("flags production reads of seed fixtures but keeps canonical pack reads", () => {
  const { violations } = scan({
    "server/app.mjs": [
      "const accounts = JSON.parse(await readFile(\"../seed/data/accounts.json\", \"utf8\"));",
      "const roster = JSON.parse(await readFile(join(\"seed\", \"accounts.json\"), \"utf8\"));",
      "const units = JSON.parse(await readFile(join(\"data\", \"seed\"), \"utf8\"));",
      "const manifest = JSON.parse(await readFile(\"../examples/packs/health/pack.json\", \"utf8\"));",
    ].join("\n"),
  });
  assert.deepEqual(violations.map((entry) => [entry.line, entry.rule]), [[1, "seed-read"], [2, "seed-read"], [3, "seed-read"]]);
  assert.match(violations[0].message, /production read of seed fixtures/u);
});

test("keeps the workspace's own .env and .env.example, flags sibling and outside .env reads", () => {
  assert.deepEqual(scan({
    "server/main.mjs": "process.loadEnvFile(\".env\");\nconst template = await readFile(\".env.example\", \"utf8\");\nprocess.loadEnvFile(join(\".\", \".env\"));",
  }).violations, []);
  for (const bad of [
    "const secrets = await readFile(\"../../junctura-health/.env\", \"utf8\");",
    "process.loadEnvFile(join(\"..\", \"other-repo\", \".env\"));",
    "const remote = await readFile(\"https://cfg.example/.env\", \"utf8\");",
    "const absolute = await readFile(\"/srv/other/.env\", \"utf8\");",
    "const local = await readFile(\".env.local\", \"utf8\");",
  ]) {
    assert.deepEqual(scan({ "server/x.mjs": `${bad}\n` }).violations.map((entry) => entry.rule), ["env-read"], bad);
  }
  assert.match(scan({ "server/x.mjs": "const x = \"../../junctura-health/.env\";\n" }).violations[0].message, /configuration comes from the process environment/u);
});

test("an allowlist entry suppresses only its exact path and rule; stale entries are reported", () => {
  const allowlist = [{ path: "server/legacy.mjs", rule: "sqlite", reason: "Legacy in-memory cache documented for removal" }];
  const contents = { "server/legacy.mjs": "const db = new DatabaseSync(path);", "server/store.mjs": "import { DatabaseSync } from \"node:sqlite\";" };
  assert.deepEqual(scan(contents, allowlist).violations, [
    { path: "server/store.mjs", line: 1, rule: "sqlite", message: "runtime business persistence in SQLite; records belong on Layer 1 through the backend SDK" },
  ]);
  assert.deepEqual(scan({ "server/neutral.mjs": "const x = 1;" }, allowlist).violations, [
    { path: "scripts/storage-allowlist.json", message: "unused allowlist entry: server/legacy.mjs: sqlite" },
  ]);
  for (const bad of [{}, [null], [{ path: "server/a.mjs", rule: "sqlite", reason: " " }]]) {
    assert.throws(() => scan({}, bad), /allowlist must be an array of entries with non-empty path, rule and reason strings, and a file-write entry also needs a non-empty line substring/u);
  }
});

test("a file-write exception names its exact line so a new write in the same module stays flagged", () => {
  const allowlist = [{ path: "server/export.mjs", rule: "file-write", line: "import { writeFile } from \"node:fs/promises\";", reason: "The operator export writes only the temp pattern recognized above" }];
  const contents = { "server/export.mjs": "import { writeFile } from \"node:fs/promises\";\nawait writeFile(join(tmpdir(), \"export.json\"), bytes);\nwriteFileSync(surprisePath, bytes);" };
  assert.deepEqual(scan(contents, allowlist).violations, [
    { path: "server/export.mjs", line: 3, rule: "file-write", message: "runtime write to a host file; business bytes belong on Layer 1 (only a direct write into join((os.)tmpdir(), …) of simple relative literals is recognized)" },
  ]);
  for (const bad of [
    { path: "server/a.mjs", rule: "file-write", reason: "Missing the exact line" },
    { path: "server/a.mjs", rule: "file-write", line: " ", reason: "Blank line" },
  ]) {
    assert.throws(() => scan({}, bad), /a file-write entry also needs a non-empty line substring/u);
  }
});

test("runCheck prints path:line diagnostics and exits 1, and passes with a zero count", () => {
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(line);
  try {
    assert.equal(runCheck({
      files: ["server/store.mjs", "server/clean.mjs"],
      read: (path) => (path === "server/store.mjs" ? "import { DatabaseSync } from \"node:sqlite\";\n" : "const x = 1;\n"),
      allowlist: [],
    }), 1);
    assert.equal(logs[0], "server/store.mjs:1: sqlite: runtime business persistence in SQLite; records belong on Layer 1 through the backend SDK");
    assert.match(logs[1], /Storage check failed: 1 violations in 2 runtime files scanned/u);
  } finally {
    console.log = original;
  }
  logs.length = 0;
  console.log = (line) => logs.push(line);
  try {
    assert.equal(runCheck({ files: ["server/clean.mjs"], read: () => "const x = 1;\n", allowlist: [] }), 0);
    assert.match(logs[0], /Storage check passed: 1 runtime files scanned/u);
  } finally {
    console.log = original;
  }
});

test("the current Workspace source satisfies the storage check", () => {
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(line);
  try {
    assert.equal(runCheck(), 0);
  } finally {
    console.log = original;
  }
  assert.match(logs.at(-1), /Storage check passed: \d+ runtime files scanned/u);
});
