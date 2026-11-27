// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Fixture regressions of `check:neutral` (issue #14): each violation group and
// the legitimate cases, verified against synthetic sources so no fixture here
// depends on the live tree. One test additionally asserts that the current
// Workspace source satisfies the check.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findViolations, runCheck } from "../check-sector-neutral.mjs";

const scan = (contents, allowlist = []) =>
  findViolations({ files: Object.keys(contents), read: (path) => contents[path], allowlist });

test("reports sector vocabulary with path and line, case-insensitively and with word prefixes", () => {
  assert.deepEqual(scan({ "app/src/example.ts": "// neutral\r\nconst a = 'BỆNH NHÂN';\r\n" }), {
    violations: [{ path: "app/src/example.ts", line: 2, term: "bệnh nhân" }],
    scanned: 1,
  });
  assert.deepEqual(scan({ "server/store.mjs": "patients clinics hospitalX" }).violations, [
    { path: "server/store.mjs", line: 1, term: "patient" },
    { path: "server/store.mjs", line: 1, term: "hospital" },
    { path: "server/store.mjs", line: 1, term: "clinic" },
  ]);
});

test("scans every runtime scope location and skips binary content", () => {
  const paths = ["app/src/a.ts", "app/src/deep/b.tsx", "packages/ui/src/c.ts", "packages/ui/src/deep/d.tsx", "server/d.mjs",
    "server/records/sqlite.mjs", "server/tools/export.ts", "app/vite.config.ts", "packages/ui/vite.config.ts",
    "app/tsconfig.json", "app/index.html", "app/public/config.example.json"];
  const result = scan(Object.fromEntries(paths.map((path) => [path, "học sinh"])));
  assert.equal(result.scanned, paths.length);
  assert.deepEqual(result.violations.map((entry) => entry.path), [...paths].sort());
  const binary = Buffer.concat([Buffer.from("patient"), Buffer.alloc(8192 - 8, 32), Buffer.from([0])]);
  assert.deepEqual(scan({ "app/src/image.bin": binary }), { violations: [], scanned: 0 });
});

test("permits pack fixtures, tests and operator tooling; never reads out-of-scope files", () => {
  assert.deepEqual(findViolations({
    files: ["examples/packs/health/pack.json", "examples/api/case.json", "app/tests/helpers.tsx",
      "server/tests/store.test.mjs", "server/tests/deep/records.test.mjs", "packages/ui/tests/a11y.test.tsx",
      "scripts/check-health-pack.mjs", "scripts/pack-install.mjs", "docs/PORTAL.md", "README.md",
      "server/Dockerfile", "server/package.json", "compose.yaml", "node_modules/x/index.js", "app/dist/main.js"],
    read: () => { throw new Error("out-of-scope files must not be read"); },
  }), { violations: [], scanned: 0 });
});

test("flags the Health alias in shipped build config entry points and vocabulary in nested server modules", () => {
  const { violations } = scan({
    "app/vite.config.ts": "const alias = \"../.junctura-health/ui\";\n",
    "server/records/sqlite.mjs": "// local cache of the clinic directory\n",
  });
  assert.deepEqual(violations.map((entry) => [entry.path, entry.line, entry.term ?? "dependency"]), [
    ["app/vite.config.ts", 1, "health"],
    ["app/vite.config.ts", 1, "dependency"],
    ["server/records/sqlite.mjs", 1, "clinic"],
  ]);
  assert.match(violations[1].message, /dependency "\.\.\/\.junctura-health\/ui": the Junctura Health checkout is a CI input/u);
});

test("flags Health/demo/seed imports and static pack-fixture imports with path and line", () => {
  const { violations } = scan({
    "app/src/leak.ts": [
      "import { ui } from \"../../junctura-health/ui/index.mjs\";",
      "import \"@junctura/health-ui/styles.css\";",
      "const plan = await import(\"../demo/plan.mjs\");",
      "import accounts from \"../seed/data/accounts.json\";",
      "import \"@demo/strings\";",
      "import manifest from \"../../examples/packs/health/pack.json\";",
    ].join("\n"),
  });
  // The vocabulary term "health" also hits inside the module names; both diagnostics are wanted.
  assert.deepEqual(violations.map((entry) => [entry.path, entry.line, entry.term ?? "import"]), [
    ["app/src/leak.ts", 1, "health"], ["app/src/leak.ts", 1, "import"],
    ["app/src/leak.ts", 2, "health"], ["app/src/leak.ts", 2, "import"],
    ["app/src/leak.ts", 3, "import"], ["app/src/leak.ts", 4, "import"], ["app/src/leak.ts", 5, "import"],
    ["app/src/leak.ts", 6, "health"], ["app/src/leak.ts", 6, "import"],
  ]);
  assert.match(violations[1].message, /import "\.\.\/\.\.\/junctura-health\/ui\/index\.mjs"/u);
  assert.match(violations[4].message, /demo\/seed\/Health source trees/u);
});

test("keeps the legitimate imports of the portal", () => {
  assert.deepEqual(scan({
    "app/src/app.tsx": "import { Button } from \"@junctura/ui\";\nimport { pack } from \"./pack/data\";\nimport type { Column } from \"@junctura/ui\";",
    "server/packs.mjs": "import { readFile } from \"node:fs/promises\";\nimport packSchema from \"../schemas/pack.schema.json\" with { type: \"json\" };",
    "app/vite.config.ts": "const ownModule = (name: string): string => fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));\n{ find: \"@junctura/ui\", replacement: fileURLToPath(new URL(\"../packages/ui/src/index.ts\", import.meta.url)) },",
    "app/tsconfig.json": "{ \"paths\": { \"@junctura/ui\": [\"../packages/ui/src/index.ts\"], \"react\": [\"./node_modules/@types/react/index.d.ts\"] } }",
  }).violations, []);
});

test("an allowlist entry suppresses only its exact path and term", () => {
  const allowlist = [{ path: "app/src/a.ts", term: "health", reason: "Documented compatibility value" }];
  assert.deepEqual(scan({ "app/src/a.ts": "health\ny tế", "app/src/b.ts": "health" }, allowlist).violations, [
    { path: "app/src/a.ts", line: 2, term: "y tế" },
    { path: "app/src/b.ts", line: 1, term: "health" },
  ]);
});

test("reports stale allowlist entries and rejects malformed allowlists", () => {
  assert.deepEqual(scan({ "app/src/neutral.ts": "const x = 1" }, [
    { path: "app/src/gone.ts", term: "patient", reason: "Obsolete exception" },
  ]).violations, [
    { path: "scripts/sector-neutral-allowlist.json", message: "unused allowlist entry: app/src/gone.ts: patient" },
  ]);
  for (const allowlist of [{}, [null], [{ path: "app/src/a.ts", term: "health", reason: " " }]]) {
    assert.throws(() => scan({}, allowlist), /allowlist must be an array of entries with non-empty path, term and reason strings/u);
  }
});

test("runCheck prints path:line diagnostics and exits 1, and passes with a zero count", () => {
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(line);
  try {
    assert.equal(runCheck({
      files: ["app/src/leak.ts", "app/src/clean.ts"],
      read: (path) => (path === "app/src/leak.ts" ? "const a = 'patient';\n" : "const b = 2;\n"),
      allowlist: [],
    }), 1);
    assert.deepEqual(logs, ["app/src/leak.ts:1: patient", "Sector-neutral check failed: 1 violations in 2 runtime files scanned"]);
  } finally {
    console.log = original;
  }
  logs.length = 0;
  console.log = (line) => logs.push(line);
  try {
    assert.equal(runCheck({ files: ["app/src/clean.ts"], read: () => "const b = 2;\n", allowlist: [] }), 0);
    assert.deepEqual(logs, ["Sector-neutral check passed: 1 runtime files scanned"]);
  } finally {
    console.log = original;
  }
});

test("the current Workspace source satisfies the sector-neutral check", () => {
  const logs = [];
  const original = console.log;
  console.log = (line) => logs.push(line);
  try {
    assert.equal(runCheck(), 0);
  } finally {
    console.log = original;
  }
  assert.match(logs.at(-1), /Sector-neutral check passed: \d+ runtime files scanned/u);
});
