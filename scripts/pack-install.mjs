// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// `pack:install` dry-run planner (issue #12, offline-first slice).
//
// This command plans one pack install deterministically and changes nothing:
// it reads and validates the pack with the shared preflight reader
// `readPack()` (server/packs.mjs, docs/PACK_FORMAT.md), then emits an ordered
// plan of the work a real install would do. The Directory PUT steps carry the
// verified shapes of the pinned Foundation contract excerpt in
// .junctura/core-reference (putDirectoryUnitType, putDirectoryUnit,
// putDirectoryGroup with their request bodies). The `ws_packs` schema
// registration and pack record write are emitted as *planned* work waiting on
// the ws_packs schema design, which this issue has not supplied yet — the Core
// data-schema endpoint itself is pinned (registerCollectionSchema), so nothing
// is claimed missing there. The BPMN definition loads wait on a different,
// real blocker: Core pins no definition-deployment operation at all
// (/v1/workflows/definitions is read-only), tracked as junctura-dxos#112.
// Planned steps carry no HTTP method, path or body — nothing is invented.
//
// Hard guarantees of this slice:
//   - validate first: a pack that fails `readPack()` is never planned;
//   - no HTTP: the planner never fetches, never dials, never authenticates;
//   - stable output: the plan is plain data with deterministic ordering and
//     no timestamps, so two runs on the same pack print byte-identical JSON;
//   - references preserved: group and unit ids are used exactly as declared,
//     so re-running the real install would address the same resources;
//   - unsupported execution is distinct from invalid input (exit codes below).
//
// Exit codes:
//   0  a dry-run plan was produced
//   1  invalid input (the pack failed validation)
//   2  usage error (missing or unknown arguments)
//   3  unsupported execution (running without --dry-run)
//
// NOT implemented (deliberately, do not claim otherwise): real execution,
// install, upgrade, removal, retry after partial failure, and the "new version
// must be greater" check — the last one needs the installed pack state, which
// only a real ws_packs read during a real install can provide.

import { pathToFileURL } from "node:url";
import { PackReadErrorCode, readPack } from "../server/packs.mjs";

/** Stable machine-readable codes of planner-level errors (docs/PACK_FORMAT.md). */
export const PlanErrorCode = Object.freeze({
  PLAN_DIRECTORY_ID_INVALID: "PLAN_DIRECTORY_ID_INVALID",
  PLAN_DEFINITION_KEY_INVALID: "PLAN_DEFINITION_KEY_INVALID",
});

/** Path parameters of the pinned Directory contract require at least two characters. */
const DIRECTORY_ID = /^[a-z][a-z0-9-]{1,63}$/;

/** The pinned Core `definitionKey` pattern: underscores, never hyphens, at least three characters. */
const DEFINITION_KEY = /^[a-z][a-z0-9_]{2,63}$/;

/** Real blocker of the definition loads: Core pins no definition-deployment operation. */
const DEFINITION_DEPLOYMENT_BLOCKER = "junctura-dxos#112";

/** The ws_packs steps wait on the schema design this issue has not supplied yet, not on DX-OS. */
const WS_PACKS_SCHEMA_BLOCKER = "junctura-workspace#12";

/**
 * Unit types each role group is bound to, derived from the workflow
 * declarations: a group belongs to the unit types that perform its steps and,
 * for the open form, to the unit types allowed to open the record
 * (`open.unitTypes` when declared, otherwise every `senderUnitTypes`).
 */
function groupUnitTypes(manifest) {
  const bound = new Map();
  const bind = (groupId, unitTypeId) => {
    if (!bound.has(groupId)) bound.set(groupId, new Set());
    bound.get(groupId).add(unitTypeId);
  };
  for (const workflow of manifest.workflows) {
    for (const unitTypeId of workflow.open.unitTypes ?? workflow.senderUnitTypes) bind(workflow.open.role, unitTypeId);
    for (const step of workflow.steps) for (const unitTypeId of step.unitTypes) bind(step.role, unitTypeId);
  }
  return bound;
}

/** Sample units in a stable parents-first order: depth first, file order for ties. */
function orderedUnits(units) {
  const byId = new Map(units.map(unit => [unit.id, unit]));
  const depth = unit => {
    let levels = 0;
    for (let current = unit; current.parent != null; current = byId.get(current.parent)) levels++;
    return levels;
  };
  return units
    .map((unit, index) => ({ unit, index }))
    .sort((a, b) => depth(a.unit) - depth(b.unit) || a.index - b.index)
    .map(item => item.unit);
}

/** The ids this plan would put into Directory path parameters must fit the pinned pattern. */
function checkDirectoryIds(manifest, units, errors) {
  const reject = (file, at, id) =>
    errors.push({
      code: PlanErrorCode.PLAN_DIRECTORY_ID_INVALID,
      file,
      path: at,
      message: `"${id}" cannot address a Directory resource: the pinned path parameters require ${DIRECTORY_ID.source}`,
    });
  manifest.unitTypes.forEach((unitType, index) => {
    if (!DIRECTORY_ID.test(unitType.id)) reject("pack.json", `/unitTypes/${index}/id`, unitType.id);
  });
  manifest.groups.forEach((group, index) => {
    if (!DIRECTORY_ID.test(group.id)) reject("pack.json", `/groups/${index}/id`, group.id);
  });
  units.forEach((unit, index) => {
    if (!DIRECTORY_ID.test(unit.id)) reject("units.json", `/units/${index}/id`, unit.id);
  });
}

/**
 * Workflow ids become BPMN definition keys, which the pinned Core pattern
 * restricts harder than the pack schema's stableId: a real validateDefinition
 * would reject anything outside it, so the planner refuses the pack first.
 */
function checkDefinitionKeys(manifest, errors) {
  manifest.workflows.forEach((workflow, index) => {
    if (!DEFINITION_KEY.test(workflow.id)) {
      errors.push({
        code: PlanErrorCode.PLAN_DEFINITION_KEY_INVALID,
        file: "pack.json",
        path: `/workflows/${index}/id`,
        message: `"${workflow.id}" cannot deploy a BPMN definition: the pinned definitionKey requires ${DEFINITION_KEY.source}`,
      });
    }
  });
}

/**
 * Plans one pack install without executing anything.
 *
 * @param {string} packDir Path of the pack directory (the folder holding pack.json).
 * @returns {Promise<{ ok: true, plan: object } | { ok: false, errors: object[] }>}
 *   On success `plan` is plain, deterministic data; on failure `errors` follows
 *   the PackError shape of docs/PACK_FORMAT.md and the pack was NOT planned.
 */
export async function planPackInstall(packDir) {
  const read = await readPack(packDir);
  if (!read.ok) return { ok: false, errors: read.errors };

  const { manifest, units: unitsFile } = read.pack;
  const units = unitsFile.units;
  const errors = [];
  checkDirectoryIds(manifest, units, errors);
  checkDefinitionKeys(manifest, errors);
  if (errors.length) return { ok: false, errors };

  const steps = [];
  for (const unitType of manifest.unitTypes) {
    steps.push({
      kind: "directory.unitType.put",
      status: "ready",
      method: "PUT",
      path: `/v1/directory/unit-types/${unitType.id}`,
      body: { name: unitType.name },
    });
  }

  const inOrder = orderedUnits(units);
  for (const unit of inOrder) {
    steps.push({
      kind: "directory.unit.put",
      status: "ready",
      method: "PUT",
      path: `/v1/directory/units/${unit.id}`,
      body: { unitType: unit.unitType, name: unit.name },
    });
  }

  const bound = groupUnitTypes(manifest);
  for (const unit of inOrder) {
    for (const group of manifest.groups) {
      if (!bound.get(group.id)?.has(unit.unitType)) continue;
      steps.push({
        kind: "directory.group.put",
        status: "ready",
        method: "PUT",
        path: `/v1/directory/units/${unit.id}/groups/${group.id}`,
        body: { name: group.name },
      });
    }
  }

  const definitionKeys = manifest.workflows.map(workflow => workflow.id);
  for (const [index, workflow] of read.pack.workflows.entries()) {
    steps.push({
      kind: "bpmn.definition.load",
      status: "planned",
      blockedBy: DEFINITION_DEPLOYMENT_BLOCKER,
      workflow: workflow.id,
      definitionKey: workflow.id,
      bpmn: workflow.bpmn,
      note: `load the BPMN 2.0 file of workflows[${index}] as definition key "${workflow.id}" (${workflow.userTaskIds.length} user tasks); the definition-deployment operation is not available yet`,
    });
  }
  steps.push({
    kind: "ws_packs.schema.register",
    status: "planned",
    blockedBy: WS_PACKS_SCHEMA_BLOCKER,
    collection: "ws_packs",
    note: "register the ws_packs collection schema with its indexed fields before the first pack record; the Core data-schema endpoint itself is pinned, but the ws_packs schema design is not supplied by this issue yet",
  });
  steps.push({
    kind: "ws_packs.packRecord.write",
    status: "planned",
    blockedBy: WS_PACKS_SCHEMA_BLOCKER,
    collection: "ws_packs",
    packId: manifest.id,
    version: manifest.version,
    definitionKeys,
    note: "record the installed pack so a later run reuses exactly these group, unit-type and definition keys; it waits for the ws_packs schema registration above",
  });

  const notes = [];
  for (const group of manifest.groups) {
    if (!bound.has(group.id)) {
      notes.push(`group "${group.id}" is declared but no workflow binds it to a unit type through a step or the open form, so the plan creates no Directory group for it`);
    }
  }
  if (units.some(unit => unit.parent != null)) {
    notes.push("the pinned DirectoryUnitWrite shape has no parent field, so the plan orders sample units parents-first (units-file order for ties) but does not carry the parent link into the PUT bodies");
  }

  return {
    ok: true,
    plan: {
      command: "pack:install",
      dryRun: true,
      mode: "install",
      pack: {
        id: manifest.id,
        version: manifest.version,
        name: manifest.name,
        formatVersion: manifest.formatVersion,
        language: manifest.language,
      },
      steps,
      notes,
    },
  };
}

const USAGE = `pack:install — plan a Junctura Workspace pack install (dry run only)

Usage:
  node scripts/pack-install.mjs <pack-dir> --dry-run

The pack is validated first, then an ordered JSON plan of the install work is
printed on stdout. Nothing is executed, no HTTP request is made and no file is
written. See docs/PACK_FORMAT.md for the plan shape and exit codes.`;

/** CLI entry: argument handling and exit codes, planning delegated to planPackInstall. */
async function cli(argv) {
  const flags = argv.filter(argument => argument.startsWith("-"));
  const positional = argv.filter(argument => !argument.startsWith("-"));

  if (flags.includes("--help") || flags.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  for (const flag of flags) {
    if (flag !== "--dry-run") {
      console.error(`unknown option "${flag}"\n\n${USAGE}`);
      return 2;
    }
  }
  if (positional.length !== 1) {
    console.error(`expected exactly one pack directory\n\n${USAGE}`);
    return 2;
  }
  if (!flags.includes("--dry-run")) {
    console.error(
      "pack:install cannot execute yet: only --dry-run is enabled, because the definition-deployment operation is not available (junctura-dxos#112). Nothing was changed.",
    );
    return 3;
  }

  const planned = await planPackInstall(positional[0]);
  if (!planned.ok) {
    console.error(JSON.stringify({ ok: false, errors: planned.errors }, null, 2));
    return 1;
  }
  console.log(JSON.stringify(planned.plan, null, 2));
  return 0;
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  process.exitCode = await cli(process.argv.slice(2));
}
