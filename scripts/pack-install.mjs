// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// `pack:install` for issue #12: the offline dry-run planner of the merged
// slice, plus real install and inspection on a Junctura DX-OS stack.
//
// `--dry-run` plans one pack install deterministically and changes nothing:
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
// This output is byte-stable between runs and unchanged by this PR.
//
// Without `--dry-run` the command performs the real install: the pack is
// validated offline first (a pack that fails `readPack()` is never planned,
// never executed), the lifecycle configuration is required from the
// environment before any network call, and execution is delegated to
// server/pack-lifecycle.mjs — operator and backend identities verified before
// mutating, the exact version and content hash reserved in the app-owned
// `ws_packs` collection before any Directory or Flowable action, deterministic
// request keys replayed on rerun, and the reservation finalized to "available"
// only after every effect committed. Explicit activation and safe retirement
// are the separate `--select`/`--retire` commands documented below.
//
// `--list` reads the recorded pack state (complete and incomplete installs)
// and the current active selection through the backend application without
// mutating anything.
//
// `--select <pack-dir>` durably selects the exact installed version whose
// mounted assets the operator points at: the pack is validated offline with
// the shared preflight reader and its content hash must equal the recorded
// hash of the installed ws_packs version (the minimal verification of a
// selected pack against mounted files), and only an available complete
// version may be selected. The swap is one atomic `POST /v2/data:batch` — the
// app-scoped `active` selection pointer plus a same-data re-validation of the
// target version under their observed ETags — so a competing select or retire
// rolls the whole batch back. Rerunning the command after any uncertain
// outcome replays under the same derived request key; the pointer of the one
// `active` record is the commit marker.
//
// `--retire <pack-id> <version>` safely retires an installed version: one
// atomic batch pins the same observed pointer ETag and marks only that
// version's record `retired`. The currently selected version is refused
// (select another installed version first); deployed BPMN definitions,
// Directory resources and prior app records are never deleted, so existing
// cases keep running.
//
// Exit codes:
//   0  the requested work was produced (plan, install, selection, retirement or listing)
//   1  invalid input (the pack failed validation) or a failed command
//   2  usage error (missing or unknown arguments)
//   3  refused without effect (lifecycle configuration missing)
import { pathToFileURL } from "node:url";
import { PackReadErrorCode, readPack } from "../server/packs.mjs";
import {
  PackLifecycleError,
  buildExecutablePlan,
  compareVersions,
  installPack,
  listInstalledPacks,
  packContentHash,
  readLifecycleConfig,
  retirePackVersion,
  selectPackVersion,
} from "../server/pack-lifecycle.mjs";

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

const USAGE = `pack:install — install, select and retire a Junctura Workspace pack

Usage:
  node scripts/pack-install.mjs <pack-dir> --dry-run
  node scripts/pack-install.mjs <pack-dir>
  node scripts/pack-install.mjs <pack-dir> --select
  node scripts/pack-install.mjs --retire <pack-id> <version>
  node scripts/pack-install.mjs --list

--dry-run validates the pack and prints an ordered JSON plan of the install
work on stdout; nothing is executed, no HTTP request is made and no file is
written. Without it the pack is validated first and then really installed on
the configured DX-OS stack (JUNCTURA_URL, JUNCTURA_TENANT,
JUNCTURA_APP_CLIENT_ID, JUNCTURA_APP_CLIENT_SECRET, JUNCTURA_OPERATOR_TOKEN —
see docs/PACK_FORMAT.md). --select points at the mounted pack directory whose
installed version becomes the app's one active selection (only a complete
available version whose recorded content matches the mounted pack; the swap is
one atomic record batch). --retire marks an installed version retired without
deleting deployed definitions, Directory resources or prior records; the
active selection is refused. --list reads the recorded pack state and the
active selection without changing anything. See docs/PACK_FORMAT.md for the
plan shape and exit codes.`;

/** Renders a lifecycle failure as the stderr payload of a failed command. */
function errorPayload(error) {
  return {
    ok: false,
    error: {
      code: error instanceof PackLifecycleError ? error.code : "PACK_INSTALL_FAILED",
      message: error?.message ?? String(error),
      ...(error?.uncertain ? { uncertain: true } : {}),
    },
  };
}

/** Renders the lifecycle configuration error as a refused command (exit 3). */
function configMissing(error) {
  console.error(`${error.message}\n\nNothing was changed.`);
  return 3;
}

/** CLI entry: argument handling and exit codes, work delegated to pure helpers. */
async function cli(argv) {
  const flags = argv.filter(argument => argument.startsWith("-"));
  const positional = argv.filter(argument => !argument.startsWith("-"));

  if (flags.includes("--help") || flags.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  for (const flag of flags) {
    if (flag !== "--dry-run" && flag !== "--list" && flag !== "--select" && flag !== "--retire") {
      console.error(`unknown option "${flag}"\n\n${USAGE}`);
      return 2;
    }
  }
  const exclusive = ["--dry-run", "--list", "--select", "--retire"].filter(flag => flags.includes(flag));
  if (exclusive.length > 1) {
    console.error(`${exclusive.join(" and ")} cannot be combined\n\n${USAGE}`);
    return 2;
  }
  if (flags.includes("--list")) {
    if (positional.length !== 0) {
      console.error(`--list takes no pack directory\n\n${USAGE}`);
      return 2;
    }
    let config;
    try {
      config = readLifecycleConfig(process.env);
    } catch (error) {
      if (error instanceof PackLifecycleError && error.code === "LIFECYCLE_CONFIG_MISSING") return configMissing(error);
      throw error;
    }
    try {
      const listing = await listInstalledPacks({ config, log: line => console.error(line) });
      console.log(JSON.stringify(listing, null, 2));
      return 0;
    } catch (error) {
      console.error(JSON.stringify(errorPayload(error), null, 2));
      return 1;
    }
  }
  if (flags.includes("--select")) {
    if (positional.length !== 1) {
      console.error(`--select expects exactly one pack directory\n\n${USAGE}`);
      return 2;
    }
    // The mounted assets are validated offline first and their content hash is
    // what selection verifies against the durable record of the target version.
    const read = await readPack(positional[0]);
    if (!read.ok) {
      console.error(JSON.stringify({ ok: false, errors: read.errors }, null, 2));
      return 1;
    }
    let config;
    try {
      config = readLifecycleConfig(process.env);
    } catch (error) {
      if (error instanceof PackLifecycleError && error.code === "LIFECYCLE_CONFIG_MISSING") return configMissing(error);
      throw error;
    }
    const packId = read.pack.manifest.id;
    const version = read.pack.manifest.version;
    const contentHash = packContentHash(read.pack);
    try {
      const outcome = await selectPackVersion({ packId, version, contentHash, config, log: line => console.error(line) });
      console.log(JSON.stringify({ ok: true, ...outcome, pack: { id: packId, version, contentHash } }, null, 2));
      return 0;
    } catch (error) {
      console.error(JSON.stringify(errorPayload(error), null, 2));
      return 1;
    }
  }
  if (flags.includes("--retire")) {
    if (positional.length !== 2) {
      console.error(`--retire expects exactly one pack id and one version\n\n${USAGE}`);
      return 2;
    }
    const [packId, version] = positional;
    if (!/^[a-z][a-z0-9-]{0,62}$/.test(packId)) {
      console.error(`"packId" must match ^[a-z][a-z0-9-]{0,62}$\n\n${USAGE}`);
      return 2;
    }
    try {
      compareVersions(version, version);
    } catch {
      console.error(`"version" must be an orderable pack version like 1.2.3 or 1.2.3-rc.1\n\n${USAGE}`);
      return 2;
    }
    let config;
    try {
      config = readLifecycleConfig(process.env);
    } catch (error) {
      if (error instanceof PackLifecycleError && error.code === "LIFECYCLE_CONFIG_MISSING") return configMissing(error);
      throw error;
    }
    try {
      const outcome = await retirePackVersion({ packId, version, config, log: line => console.error(line) });
      console.log(JSON.stringify({ ok: true, pack: { id: packId, version }, ...outcome }, null, 2));
      return 0;
    } catch (error) {
      console.error(JSON.stringify(errorPayload(error), null, 2));
      return 1;
    }
  }
  if (positional.length !== 1) {
    console.error(`expected exactly one pack directory\n\n${USAGE}`);
    return 2;
  }

  // The pack is always validated and planned offline first: a pack that fails
  // validation is never planned and never executed, with or without --dry-run.
  const planned = await planPackInstall(positional[0]);
  if (!planned.ok) {
    console.error(JSON.stringify({ ok: false, errors: planned.errors }, null, 2));
    return 1;
  }
  if (flags.includes("--dry-run")) {
    console.log(JSON.stringify(planned.plan, null, 2));
    return 0;
  }

  // Real install: the lifecycle configuration is required before anything
  // talks to the stack, so a missing configuration refuses without effect.
  let config;
  try {
    config = readLifecycleConfig(process.env);
  } catch (error) {
    if (error instanceof PackLifecycleError && error.code === "LIFECYCLE_CONFIG_MISSING") return configMissing(error);
    throw error;
  }
  const read = await readPack(positional[0]);
  if (!read.ok) {
    console.error(JSON.stringify({ ok: false, errors: read.errors }, null, 2));
    return 1;
  }
  try {
    const executable = buildExecutablePlan({ plan: planned, pack: read.pack, tenant: config.tenant });
    const outcome = await installPack({ plan: executable.plan, config, log: line => console.error(line) });
    console.log(JSON.stringify({
      ok: true,
      outcome: outcome.outcome,
      pack: executable.plan.pack,
      record: outcome.record,
    }, null, 2));
    return 0;
  } catch (error) {
    console.error(JSON.stringify(errorPayload(error), null, 2));
    return 1;
  }
}

const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === invoked) {
  process.exitCode = await cli(process.argv.slice(2));
}
