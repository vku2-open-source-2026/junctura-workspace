// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Contract tests of the `pack:install` dry-run planner (issue #12 offline-first
// slice, docs/PACK_FORMAT.md). The command is exercised end to end as a child
// process: the real merged Education pack must produce a byte-stable ordered
// plan without a single network call, invalid fixtures must be rejected with
// stable error codes, and unsupported execution must be distinct from invalid
// input. The planner never writes anywhere; fixtures run on throwaway copies
// in the OS temp dir.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PlanErrorCode } from "../../scripts/pack-install.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "scripts", "pack-install.mjs");
const EDUCATION = path.join(ROOT, "examples", "packs", "education");

const BLOCKER = "junctura-dxos#112";
const WS_PACKS_BLOCKER = "junctura-workspace#12";

/** Runs the CLI as a user would and returns { status, stdout, stderr }. */
function run(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", ...options });
}

/** Copies the education fixture into a throwaway pack dir and hands its path to `run`. */
async function withPackCopy(run) {
  const base = await mkdtemp(path.join(tmpdir(), "junctura-install-"));
  const pack = path.join(base, "pack");
  await cp(EDUCATION, pack, { recursive: true });
  try {
    return await run(pack, base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const readManifest = async pack => JSON.parse(await readFile(path.join(pack, "pack.json"), "utf8"));

test("the merged education pack dry-runs into the documented ordered plan", async () => {
  const { status, stdout, stderr } = run([EDUCATION, "--dry-run"]);
  assert.equal(status, 0, `expected exit 0, got ${status} with stderr ${stderr}`);
  assert.equal(stderr, "");
  const plan = JSON.parse(stdout);

  assert.deepEqual(plan, {
    command: "pack:install",
    dryRun: true,
    mode: "install",
    pack: { id: "education", version: "0.2.0", name: "Gói Giáo dục", formatVersion: 1, language: "vi" },
    steps: [
      { kind: "directory.unitType.put", status: "ready", method: "PUT", path: "/v1/directory/unit-types/phong-giao-duc", body: { name: "Phòng Giáo dục" } },
      { kind: "directory.unitType.put", status: "ready", method: "PUT", path: "/v1/directory/unit-types/truong", body: { name: "Trường học" } },
      { kind: "directory.unit.put", status: "ready", method: "PUT", path: "/v1/directory/units/phong-giao-duc-huyen-a", body: { unitType: "phong-giao-duc", name: "Phòng Giáo dục Huyện A" } },
      { kind: "directory.unit.put", status: "ready", method: "PUT", path: "/v1/directory/units/truong-tieu-hoc-a1", body: { unitType: "truong", name: "Tiểu học A1" } },
      { kind: "directory.unit.put", status: "ready", method: "PUT", path: "/v1/directory/units/truong-thcs-a2", body: { unitType: "truong", name: "THCS A2" } },
      { kind: "directory.group.put", status: "ready", method: "PUT", path: "/v1/directory/units/phong-giao-duc-huyen-a/groups/van-thu", body: { name: "Văn thư" } },
      { kind: "directory.group.put", status: "ready", method: "PUT", path: "/v1/directory/units/phong-giao-duc-huyen-a/groups/lanh-dao", body: { name: "Lãnh đạo đơn vị" } },
      { kind: "directory.group.put", status: "ready", method: "PUT", path: "/v1/directory/units/truong-tieu-hoc-a1/groups/hoc-vu", body: { name: "Học vụ" } },
      { kind: "directory.group.put", status: "ready", method: "PUT", path: "/v1/directory/units/truong-tieu-hoc-a1/groups/lanh-dao", body: { name: "Lãnh đạo đơn vị" } },
      { kind: "directory.group.put", status: "ready", method: "PUT", path: "/v1/directory/units/truong-thcs-a2/groups/hoc-vu", body: { name: "Học vụ" } },
      { kind: "directory.group.put", status: "ready", method: "PUT", path: "/v1/directory/units/truong-thcs-a2/groups/lanh-dao", body: { name: "Lãnh đạo đơn vị" } },
      {
        kind: "bpmn.definition.load", status: "planned", blockedBy: BLOCKER, workflow: "chuyentruong",
        definitionKey: "chuyentruong", bpmn: "workflows/chuyen-truong.bpmn20.xml",
        note: 'load the BPMN 2.0 file of workflows[0] as definition key "chuyentruong" (3 user tasks); the definition-deployment operation is not available yet',
      },
      {
        kind: "bpmn.definition.load", status: "planned", blockedBy: BLOCKER, workflow: "capbansaohocba",
        definitionKey: "capbansaohocba", bpmn: "workflows/cap-ban-sao-hoc-ba.bpmn20.xml",
        note: 'load the BPMN 2.0 file of workflows[1] as definition key "capbansaohocba" (2 user tasks); the definition-deployment operation is not available yet',
      },
      {
        kind: "ws_packs.schema.register", status: "planned", blockedBy: WS_PACKS_BLOCKER, collection: "ws_packs",
        note: "register the ws_packs collection schema with its indexed fields before the first pack record; the Core data-schema endpoint itself is pinned, but the ws_packs schema design is not supplied by this issue yet",
      },
      {
        kind: "ws_packs.packRecord.write", status: "planned", blockedBy: WS_PACKS_BLOCKER, collection: "ws_packs",
        packId: "education", version: "0.2.0", definitionKeys: ["chuyentruong", "capbansaohocba"],
        note: "record the installed pack so a later run reuses exactly these group, unit-type and definition keys; it waits for the ws_packs schema registration above",
      },
    ],
    notes: [
      "the pinned DirectoryUnitWrite shape has no parent field, so the plan orders sample units parents-first (units-file order for ties) but does not carry the parent link into the PUT bodies",
    ],
  });
});

test("repeated dry runs print a byte-identical plan", async () => {
  const first = run([EDUCATION, "--dry-run"]);
  const second = run([EDUCATION, "--dry-run"]);
  assert.equal(first.status, 0);
  assert.equal(second.status, 0);
  assert.equal(first.stdout, second.stdout);
});

test("the dry run makes no network request of any kind", async () => {
  const base = await mkdtemp(path.join(tmpdir(), "junctura-nonet-"));
  const preload = path.join(base, "poison-network.cjs");
  await writeFile(preload, `
    "use strict";
    for (const name of ["node:http", "node:https"]) {
      const mod = require(name);
      for (const method of ["request", "get"]) {
        mod[method] = () => { throw new Error("the pack:install dry run used the network"); };
      }
    }
    globalThis.fetch = () => { throw new Error("the pack:install dry run used the network"); };
  `);
  try {
    const { status, stdout, stderr } = run([EDUCATION, "--dry-run"], {
      env: { ...process.env, NODE_OPTIONS: `--require ${preload}` },
    });
    assert.equal(status, 0, `expected exit 0 with poisoned network, got ${status} with stderr ${stderr}`);
    assert.equal(JSON.parse(stdout).pack.id, "education");
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("every ready step is a Directory PUT with a pinned shape and planned steps carry no HTTP details", async () => {
  const { status, stdout } = run([EDUCATION, "--dry-run"]);
  assert.equal(status, 0);
  const plan = JSON.parse(stdout);
  for (const step of plan.steps) {
    if (step.status === "ready") {
      assert.equal(step.method, "PUT");
      assert.match(step.path, /^\/v1\/directory\//);
      assert.deepEqual(Object.keys(step.body).sort(), step.kind === "directory.unit.put" ? ["name", "unitType"] : ["name"]);
    } else {
      assert.equal(step.status, "planned");
      assert.equal(step.blockedBy, step.kind === "bpmn.definition.load" ? BLOCKER : WS_PACKS_BLOCKER, `${step.kind} waits on its real blocker: definition deployment on junctura-dxos#112, the ws_packs schema design on this issue`);
      assert.equal(step.method, undefined, "a planned step invents no HTTP method");
      assert.equal(step.path, undefined, "a planned step invents no HTTP path");
    }
  }
});

test("a schema-invalid manifest is rejected with exit 1 and PackError codes", async () => {
  await withPackCopy(async pack => {
    const manifest = await readManifest(pack);
    delete manifest.language;
    await writeFile(path.join(pack, "pack.json"), JSON.stringify(manifest, null, 2));
    const { status, stdout, stderr } = run([pack, "--dry-run"]);
    assert.equal(status, 1);
    assert.equal(stdout, "");
    const errors = JSON.parse(stderr).errors;
    assert.ok(errors.some(error => error.code === "PACK_MANIFEST_INVALID" && error.file === "pack.json"));
  });
});

test("duplicate ids and dangling references are rejected with their stable codes", async () => {
  await withPackCopy(async pack => {
    // duplicate sample unit id
    const unitsFile = JSON.parse(await readFile(path.join(pack, "units.json"), "utf8"));
    unitsFile.units[1].id = unitsFile.units[0].id;
    await writeFile(path.join(pack, "units.json"), JSON.stringify(unitsFile, null, 2));
    let outcome = run([pack, "--dry-run"]);
    assert.equal(outcome.status, 1);
    assert.ok(JSON.parse(outcome.stderr).errors.some(error => error.code === "PACK_DUPLICATE_ID" && error.file === "units.json"));

    // dangling unit type reference
    unitsFile.units[1].id = "truong-tieu-hoc-a1";
    unitsFile.units[1].unitType = "khong-ton-tai";
    await writeFile(path.join(pack, "units.json"), JSON.stringify(unitsFile, null, 2));
    outcome = run([pack, "--dry-run"]);
    assert.equal(outcome.status, 1);
    assert.ok(JSON.parse(outcome.stderr).errors.some(error => error.code === "PACK_REF_NOT_FOUND" && error.path === "/units/1/unitType"));
  });
});

test("a pack directory that fails preflight is invalid input, exit 1", async () => {
  const { status, stdout, stderr } = run([path.join(ROOT, "examples", "packs", "goi-khong-ton-tai"), "--dry-run"]);
  assert.equal(status, 1);
  assert.equal(stdout, "");
  const errors = JSON.parse(stderr).errors;
  assert.equal(errors[0].code, "PACK_DIR_UNREADABLE");
});

test("a missing BPMN file is rejected before any planning", async () => {
  await withPackCopy(async pack => {
    await rm(path.join(pack, "workflows", "chuyen-truong.bpmn20.xml"));
    const { status, stdout, stderr } = run([pack, "--dry-run"]);
    assert.equal(status, 1);
    assert.equal(stdout, "");
    const errors = JSON.parse(stderr).errors;
    assert.ok(errors.some(error => error.code === "PACK_BPMN_MISSING" && error.file === "workflows/chuyen-truong.bpmn20.xml"));
  });
});

test("ids too short for the pinned Directory path parameters are rejected before any planning", async () => {
  await withPackCopy(async pack => {
    const manifest = JSON.parse(await readFile(path.join(pack, "pack.json"), "utf8"));
    manifest.unitTypes = manifest.unitTypes.map(unitType => (unitType.id === "truong" ? { ...unitType, id: "t" } : unitType));
    for (const workflow of manifest.workflows) {
      workflow.senderUnitTypes = workflow.senderUnitTypes.map(id => (id === "truong" ? "t" : id));
      workflow.receiverUnitTypes = workflow.receiverUnitTypes.map(id => (id === "truong" ? "t" : id));
      for (const step of workflow.steps) step.unitTypes = step.unitTypes.map(id => (id === "truong" ? "t" : id));
    }
    await writeFile(path.join(pack, "pack.json"), JSON.stringify(manifest, null, 2));
    const unitsFile = JSON.parse(await readFile(path.join(pack, "units.json"), "utf8"));
    for (const unit of unitsFile.units) if (unit.unitType === "truong") unit.unitType = "t";
    await writeFile(path.join(pack, "units.json"), JSON.stringify(unitsFile, null, 2));

    const { status, stdout, stderr } = run([pack, "--dry-run"]);
    assert.equal(status, 1);
    assert.equal(stdout, "");
    const errors = JSON.parse(stderr).errors;
    assert.equal(errors[0].code, PlanErrorCode.PLAN_DIRECTORY_ID_INVALID);
    assert.equal(errors[0].file, "pack.json");
    assert.ok(errors[0].message.includes("t"));
  });
});

test("definition keys outside the pinned Core pattern are rejected before any planning", async () => {
  // The old health draft stays schema-valid (the stableId pattern allows hyphens),
  // but a real validateDefinition would reject its hyphenated workflow ids as
  // definition keys, so the planner must refuse the pack instead of planning.
  const { status, stdout, stderr } = run([path.join(ROOT, "examples", "packs", "health"), "--dry-run"]);
  assert.equal(status, 1);
  assert.equal(stdout, "");
  const errors = JSON.parse(stderr).errors;
  assert.deepEqual(
    errors.map(({ code, file, path }) => [code, file, path]),
    [
      [PlanErrorCode.PLAN_DEFINITION_KEY_INVALID, "pack.json", "/workflows/0/id"],
      [PlanErrorCode.PLAN_DEFINITION_KEY_INVALID, "pack.json", "/workflows/1/id"],
    ],
  );
  assert.match(errors[0].message, /chuyen-tuyen/);
  assert.match(errors[0].message, /\[a-z\]\[a-z0-9_\]\{2,63\}/);
});

test("running without --dry-run is unsupported execution, exit 3", async () => {
  const { status, stdout, stderr } = run([EDUCATION]);
  assert.equal(status, 3, "unsupported execution must be distinct from invalid input");
  assert.equal(stdout, "");
  assert.match(stderr, /junctura-dxos#112/);
  assert.match(stderr, /Nothing was changed/);
});

test("usage errors exit 2 and --help exits 0 with the usage text", () => {
  assert.equal(run([EDUCATION, "--execute"]).status, 2);
  assert.equal(run([]).status, 2);
  assert.equal(run([EDUCATION, "--dry-run", "them-tuy-chon"]).status, 2);
  const help = run(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /pack:install/);
});

test("a declared group that no workflow binds to a unit type produces a note and no group steps", async () => {
  await withPackCopy(async pack => {
    const manifest = await readManifest(pack);
    manifest.groups.push({ id: "giam-khao", name: "Giám khảo" });
    await writeFile(path.join(pack, "pack.json"), JSON.stringify(manifest, null, 2));
    const { status, stdout, stderr } = run([pack, "--dry-run"]);
    assert.equal(status, 0, `expected exit 0, got ${status} with stderr ${stderr}`);
    const plan = JSON.parse(stdout);
    assert.ok(plan.steps.every(step => step.kind !== "directory.group.put" || !step.path.includes("/groups/giam-khao")));
    assert.deepEqual(plan.notes, [
      'group "giam-khao" is declared but no workflow binds it to a unit type through a step or the open form, so the plan creates no Directory group for it',
      "the pinned DirectoryUnitWrite shape has no parent field, so the plan orders sample units parents-first (units-file order for ties) but does not carry the parent link into the PUT bodies",
    ]);
  });
});
