// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Local preflight reader for Junctura Workspace industry packs (format v1).
//
// readPack() reads one pack directory from disk and returns either the parsed
// manifest, sample units and per-workflow BPMN metadata, or a list of errors
// with stable codes and paths (RFC 6901 JSON pointers for JSON documents,
// XPath-like locators for BPMN). The later `pack:install` command and the
// record-type library share this preflight; the contract is documented in
// docs/PACK_FORMAT.md.
//
// The reader is pure: no network, no API calls, no writes, no database, no
// authentication. Structure comes from the published draft 2020-12 JSON
// Schemas in schemas/, compiled with Ajv. What a single document cannot
// express — the cross-file and cross-array invariants listed in
// docs/PACK_FORMAT.md — is checked here. BPMN files are parsed with a
// namespace-aware parser that rejects DTDs, so external references can be
// neither fetched nor expanded.
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { SaxesParser } from "saxes";
import packSchema from "../schemas/pack.schema.json" with { type: "json" };
import unitsSchema from "../schemas/units.schema.json" with { type: "json" };

const BPMN_NS = "http://www.omg.org/spec/BPMN/20100524/MODEL";

/** Stable machine-readable codes of `PackError`; the contract lives in docs/PACK_FORMAT.md. */
export const PackReadErrorCode = Object.freeze({
  PACK_DIR_UNREADABLE: "PACK_DIR_UNREADABLE",
  PACK_MANIFEST_ESCAPE: "PACK_MANIFEST_ESCAPE",
  PACK_MANIFEST_UNREADABLE: "PACK_MANIFEST_UNREADABLE",
  PACK_MANIFEST_INVALID: "PACK_MANIFEST_INVALID",
  PACK_UNITS_ESCAPE: "PACK_UNITS_ESCAPE",
  PACK_UNITS_UNREADABLE: "PACK_UNITS_UNREADABLE",
  PACK_UNITS_INVALID: "PACK_UNITS_INVALID",
  PACK_DUPLICATE_ID: "PACK_DUPLICATE_ID",
  PACK_REF_NOT_FOUND: "PACK_REF_NOT_FOUND",
  PACK_OPEN_ROLE_NOT_SENDER: "PACK_OPEN_ROLE_NOT_SENDER",
  PACK_OPEN_UNIT_TYPE_NOT_ALLOWED: "PACK_OPEN_UNIT_TYPE_NOT_ALLOWED",
  PACK_STEP_ROLE_NOT_IN_WORKFLOW: "PACK_STEP_ROLE_NOT_IN_WORKFLOW",
  PACK_STEP_UNIT_TYPE_NOT_ALLOWED: "PACK_STEP_UNIT_TYPE_NOT_ALLOWED",
  PACK_UNIT_CYCLE: "PACK_UNIT_CYCLE",
  PACK_UNIT_TREE_INVALID: "PACK_UNIT_TREE_INVALID",
  PACK_BPMN_ESCAPE: "PACK_BPMN_ESCAPE",
  PACK_BPMN_MISSING: "PACK_BPMN_MISSING",
  PACK_BPMN_UNREADABLE: "PACK_BPMN_UNREADABLE",
  PACK_BPMN_XML_INVALID: "PACK_BPMN_XML_INVALID",
  PACK_BPMN_PROCESS_ID_MISMATCH: "PACK_BPMN_PROCESS_ID_MISMATCH",
  PACK_BPMN_STEP_MISMATCH: "PACK_BPMN_STEP_MISMATCH",
});

const CODE = PackReadErrorCode;

const ajv = new Ajv2020({ allErrors: true });
const validatePackManifest = ajv.compile(packSchema);
const validateUnits = ajv.compile(unitsSchema);

/**
 * @typedef {Object} PackError
 * @property {string} code One of `PackReadErrorCode`.
 * @property {string} file Pack-relative file the error belongs to ("pack.json",
 *   the units file, a BPMN path) or "." for the pack directory itself.
 * @property {string} path Location within `file`: an RFC 6901 JSON pointer for
 *   JSON documents, an XPath-like locator for BPMN, or "" for file-level problems.
 * @property {string} message Human-readable detail.
 */

/**
 * @typedef {Object} PackWorkflowContents
 * @property {string} id Workflow id from the manifest.
 * @property {string} bpmn BPMN path exactly as written in the manifest.
 * @property {string} processId The `process/@id` of the BPMN file.
 * @property {string[]} userTaskIds All `userTask` ids inside the process, in document order.
 * @property {string} xml The BPMN source text, as read.
 */

/**
 * @typedef {Object} PackContents
 * @property {Record<string, unknown>} manifest pack.json parsed, unchanged.
 * @property {Record<string, unknown>} units The units file parsed, unchanged.
 * @property {PackWorkflowContents[]} workflows In manifest order.
 */

/**
 * @typedef {Object} PackReadResult
 * @property {boolean} ok True when the pack passed every check; then `pack` is set.
 * @property {PackContents} [pack] Present only when `ok`.
 * @property {PackError[]} [errors] Non-empty only when `!ok`.
 */

const packError = (code, file, at, message) => ({ code, file, path: at, message });

/** True when `target` is `root` itself or lives below it (lexically). */
function contained(root, target) {
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  return target === root || target.startsWith(base);
}

/**
 * Resolves a pack-relative reference against the real pack root and proves
 * containment before the caller opens the file, symlinks included: a link
 * that resolves outside the pack directory is an escape, a dangling one is
 * missing, a looping one or a non-regular file is unreadable.
 */
async function resolveInside(root, rel) {
  if (path.isAbsolute(rel)) return { escape: true };
  const target = path.resolve(root, rel);
  if (!contained(root, target)) return { escape: true };
  let real;
  try {
    real = await realpath(target);
  } catch (error) {
    if (error.code === "ENOENT") return { missing: true };
    if (error.code === "ELOOP") return { problem: "the path is a symlink loop" };
    return { problem: error.message };
  }
  if (!contained(root, real)) return { escape: true };
  try {
    if (!(await stat(real)).isFile()) return { problem: "the path is not a regular file" };
  } catch (error) {
    return { problem: error.message };
  }
  return { real };
}

async function readJsonDocument(file, label) {
  try {
    return { ok: true, value: JSON.parse(await readFile(file, "utf8")) };
  } catch (error) {
    const detail = error instanceof SyntaxError ? "invalid JSON" : "unreadable";
    return { ok: false, message: `${label}: ${detail}: ${error.message}` };
  }
}

/** Validates one document against its compiled schema and maps the errors to PackError. */
function schemaErrors(value, validate, file, code) {
  validate(value);
  if (!validate.errors) return [];
  return validate.errors.map(e => packError(code, file, e.instancePath, `${e.instancePath || "/"} ${e.message}`));
}

/** Collects duplicate ids of one array (`entries`) in the file, pointing at the second occurrence. */
function duplicateIds(errors, file, entries, pointer, scope) {
  const seen = new Map();
  entries.forEach((entry, index) => {
    const id = entry?.id;
    if (typeof id !== "string") return; // malformed entries are schema errors
    if (seen.has(id)) {
      errors.push(packError(CODE.PACK_DUPLICATE_ID, file, `${pointer}/${index}/id`, `"${id}" duplicates the ${scope} id at ${pointer}/${seen.get(id)}/id`));
    } else {
      seen.set(id, index);
    }
  });
}

const refError = (file, at, id, target) =>
  packError(CODE.PACK_REF_NOT_FOUND, file, at, `"${id}" does not match any id in ${target}`);

/** Cross references inside a schema-valid manifest (docs/PACK_FORMAT.md, checks 1, 2 and 4). */
function checkManifestReferences(manifest, errors) {
  const unitTypeIds = new Set(manifest.unitTypes.map(unitType => unitType.id));
  const groupIds = new Set(manifest.groups.map(group => group.id));
  const recordTypeIds = new Set(manifest.recordTypes.map(recordType => recordType.id));

  duplicateIds(errors, "pack.json", manifest.groups, "/groups", "groups");
  duplicateIds(errors, "pack.json", manifest.unitTypes, "/unitTypes", "unitTypes");
  duplicateIds(errors, "pack.json", manifest.recordTypes, "/recordTypes", "recordTypes");
  duplicateIds(errors, "pack.json", manifest.workflows, "/workflows", "workflows");

  manifest.workflows.forEach((workflow, index) => {
    const at = `/workflows/${index}`;
    if (!recordTypeIds.has(workflow.recordType)) errors.push(refError("pack.json", `${at}/recordType`, workflow.recordType, "recordTypes"));

    for (const field of ["senderUnitTypes", "receiverUnitTypes"]) {
      workflow[field].forEach((id, i) => {
        if (!unitTypeIds.has(id)) errors.push(refError("pack.json", `${at}/${field}/${i}`, id, "unitTypes"));
      });
    }
    for (const field of ["senderGroups", "receiverGroups"]) {
      workflow[field].forEach((id, i) => {
        if (!groupIds.has(id)) errors.push(refError("pack.json", `${at}/${field}/${i}`, id, "groups"));
      });
    }

    if (!groupIds.has(workflow.open.role)) {
      errors.push(refError("pack.json", `${at}/open/role`, workflow.open.role, "groups"));
    } else if (!workflow.senderGroups.includes(workflow.open.role)) {
      errors.push(packError(CODE.PACK_OPEN_ROLE_NOT_SENDER, "pack.json", `${at}/open/role`, `"${workflow.open.role}" opens the record but is not one of senderGroups [${workflow.senderGroups.join(", ")}]`));
    }
    workflow.open.unitTypes?.forEach((id, i) => {
      if (!unitTypeIds.has(id)) errors.push(refError("pack.json", `${at}/open/unitTypes/${i}`, id, "unitTypes"));
      else if (!workflow.senderUnitTypes.includes(id)) {
        errors.push(packError(CODE.PACK_OPEN_UNIT_TYPE_NOT_ALLOWED, "pack.json", `${at}/open/unitTypes/${i}`, `"${id}" is not a senderUnitType [${workflow.senderUnitTypes.join(", ")}], so it cannot open records`));
      }
    });

    duplicateIds(errors, "pack.json", workflow.steps, `${at}/steps`, "steps");
    const senderOrReceiver = new Set([...workflow.senderUnitTypes, ...workflow.receiverUnitTypes]);
    workflow.steps.forEach((step, stepIndex) => {
      const sat = `${at}/steps/${stepIndex}`;
      if (!groupIds.has(step.role)) {
        errors.push(refError("pack.json", `${sat}/role`, step.role, "groups"));
      } else if (!workflow.senderGroups.includes(step.role) && !workflow.receiverGroups.includes(step.role)) {
        errors.push(packError(CODE.PACK_STEP_ROLE_NOT_IN_WORKFLOW, "pack.json", `${sat}/role`, `"${step.role}" is neither in senderGroups [${workflow.senderGroups.join(", ")}] nor receiverGroups [${workflow.receiverGroups.join(", ")}]`));
      }
      step.unitTypes.forEach((id, i) => {
        if (!unitTypeIds.has(id)) errors.push(refError("pack.json", `${sat}/unitTypes/${i}`, id, "unitTypes"));
        else if (!senderOrReceiver.has(id)) {
          errors.push(packError(CODE.PACK_STEP_UNIT_TYPE_NOT_ALLOWED, "pack.json", `${sat}/unitTypes/${i}`, `"${id}" is not a senderUnitType or receiverUnitType of the workflow [${[...senderOrReceiver].join(", ")}]`));
        }
      });
      duplicateIds(errors, "pack.json", step.decisions, `${sat}/decisions`, "decisions");
      if (step.form) duplicateIds(errors, "pack.json", step.form.fields, `${sat}/form/fields`, "fields");
    });
    duplicateIds(errors, "pack.json", workflow.open.form.fields, `${at}/open/form/fields`, "fields");
  });
}

/** Sample units: unitType references, parent references, cycles and exactly one root (checks 1 and 5). */
function checkUnitTree(units, unitTypeIds, errors) {
  duplicateIds(errors, "units.json", units, "/units", "units");
  const byId = new Map(units.map(unit => [unit.id, unit]));

  units.forEach((unit, index) => {
    if (!unitTypeIds.has(unit.unitType)) errors.push(refError("units.json", `/units/${index}/unitType`, unit.unitType, "unitTypes of pack.json"));
    if (unit.parent != null && !byId.has(unit.parent)) errors.push(refError("units.json", `/units/${index}/parent`, unit.parent, "units of the same file"));
  });

  const done = new Set();
  for (const unit of units) {
    const onChain = new Set();
    let current = unit.id;
    while (current != null && byId.has(current) && !done.has(current)) {
      done.add(current);
      onChain.add(current);
      current = byId.get(current).parent ?? null;
      if (current != null && onChain.has(current)) {
        const index = units.indexOf(byId.get(current));
        errors.push(packError(CODE.PACK_UNIT_CYCLE, "units.json", `/units/${index}/parent`, `"${current}" is its own ancestor through the parent chain`));
        break;
      }
    }
  }

  const roots = units.filter(unit => unit.parent == null);
  if (roots.length !== 1) {
    errors.push(packError(CODE.PACK_UNIT_TREE_INVALID, "units.json", "/units", `the unit tree must have exactly one root, found ${roots.length}${roots.length === 0 ? " (every unit has a parent)" : `: ${roots.map(unit => unit.id).join(", ")}`}`));
  }
}

/**
 * Parses BPMN 2.0 XML namespace-aware and rejects DTDs, so no external
 * reference is ever resolved. The process must be a direct child of
 * <definitions>, and only the userTasks inside that process count: a task
 * moved out of the process cannot satisfy the manifest, while descendants
 * through BPMN subprocesses still do.
 */
function parseBpmn(source) {
  const problems = [];
  const processIds = [];
  const userTaskIds = [];
  let root = null;
  let failed = false;
  let depth = 0;
  const openProcesses = [];
  const fail = problem => {
    if (!failed) {
      failed = true;
      problems.push(problem);
    }
  };
  const idAttribute = attributes => {
    for (const attribute of Object.values(attributes)) {
      if (attribute.uri === "" && attribute.local === "id") return attribute.value;
    }
    return null;
  };

  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => fail("the file declares a DOCTYPE/DTD; the pack format forbids DTDs and external references"));
  parser.on("error", error => fail(`invalid XML: ${error.message}`));
  parser.on("opentag", node => {
    if (failed) return;
    if (!root) root = { uri: node.uri, local: node.local };
    depth++;
    if (node.uri !== BPMN_NS) return;
    if (node.local === "process") {
      if (depth === 2) processIds.push(idAttribute(node.attributes));
      else fail("the <process> element must be a direct child of <definitions>");
      openProcesses.push(depth);
    } else if (node.local === "userTask" && openProcesses.length > 0) {
      userTaskIds.push(idAttribute(node.attributes));
    }
  });
  parser.on("closetag", node => {
    depth--;
    if (node.uri === BPMN_NS && node.local === "process") openProcesses.pop();
  });
  try {
    parser.write(source).close();
  } catch (error) {
    fail(`invalid XML: ${error.message}`);
  }

  if (!failed) {
    if (!root) problems.push("the document has no root element");
    else if (root.uri !== BPMN_NS || root.local !== "definitions") problems.push(`the root element must be <definitions> in the BPMN 2.0 namespace, found <${root.local}>`);
    if (processIds.length !== 1) problems.push(`expected exactly one <process> element in the BPMN 2.0 namespace, found ${processIds.length}`);
    else if (processIds[0] == null) problems.push("the <process> element has no id attribute");
    const seen = new Set();
    for (const id of userTaskIds) {
      if (id == null) problems.push("a <userTask> element has no id attribute");
      else if (seen.has(id)) problems.push(`duplicate <userTask> id "${id}"`);
      else seen.add(id);
    }
  }
  return { problems, processId: processIds.length === 1 ? processIds[0] : null, userTaskIds: userTaskIds.filter(id => id != null) };
}

/** One workflow: containment and existence of its BPMN file, then the XML and the id cross checks (check 3). */
async function checkWorkflowBpmn(workflow, index, root, errors) {
  const file = workflow.bpmn;
  const resolved = await resolveInside(root, file);
  if (resolved.escape) {
    errors.push(packError(CODE.PACK_BPMN_ESCAPE, file, "", `"${file}" resolves outside the pack directory`));
    return null;
  }
  if (resolved.missing) {
    errors.push(packError(CODE.PACK_BPMN_MISSING, file, "", `"${file}" does not exist in the pack directory`));
    return null;
  }
  if (resolved.problem) {
    errors.push(packError(CODE.PACK_BPMN_UNREADABLE, file, "", `"${file}": ${resolved.problem}`));
    return null;
  }

  let source;
  try {
    source = await readFile(resolved.real, "utf8");
  } catch (error) {
    errors.push(packError(CODE.PACK_BPMN_UNREADABLE, file, "", `"${file}" is not readable: ${error.message}`));
    return null;
  }
  const { problems, processId, userTaskIds } = parseBpmn(source);
  for (const problem of problems) errors.push(packError(CODE.PACK_BPMN_XML_INVALID, file, "", problem));
  if (problems.length) return null;

  if (processId !== workflow.id) {
    errors.push(packError(CODE.PACK_BPMN_PROCESS_ID_MISMATCH, file, "/process/@id", `process/@id "${processId}" does not match the workflow id "${workflow.id}"`));
  }
  const taskIds = new Set(userTaskIds);
  const stepIds = new Set(workflow.steps.map(step => step.id));
  workflow.steps.forEach((step, stepIndex) => {
    if (!taskIds.has(step.id)) errors.push(packError(CODE.PACK_BPMN_STEP_MISMATCH, file, "/process/userTask", `the workflow has step "${step.id}" (/workflows/${index}/steps/${stepIndex}/id) but the BPMN file has no <userTask> with that id`));
  });
  userTaskIds.forEach(id => {
    if (!stepIds.has(id)) errors.push(packError(CODE.PACK_BPMN_STEP_MISMATCH, file, "/process/userTask/@id", `the BPMN file has <userTask> "${id}" but no step declares that id`));
  });
  return { id: workflow.id, bpmn: file, processId, userTaskIds, xml: source };
}

/**
 * Reads and validates one pack directory (docs/PACK_FORMAT.md).
 *
 * @param {string} packDir Path of the pack directory (the folder holding pack.json).
 * @returns {Promise<PackReadResult>}
 */
export async function readPack(packDir) {
  let root;
  try {
    root = await realpath(packDir);
    if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
  } catch (error) {
    return { ok: false, errors: [packError(CODE.PACK_DIR_UNREADABLE, ".", "", `the pack directory is missing or not a directory: ${error.message}`)] };
  }

  // The manifest gates every dependent read: skip everything else when it is
  // missing, escapes the pack directory or fails its schema.
  const manifestResolved = await resolveInside(root, "pack.json");
  if (manifestResolved.escape) return { ok: false, errors: [packError(CODE.PACK_MANIFEST_ESCAPE, "pack.json", "", '"pack.json" resolves outside the pack directory')] };
  if (manifestResolved.missing) return { ok: false, errors: [packError(CODE.PACK_MANIFEST_UNREADABLE, "pack.json", "", "pack.json does not exist in the pack directory")] };
  if (manifestResolved.problem) return { ok: false, errors: [packError(CODE.PACK_MANIFEST_UNREADABLE, "pack.json", "", `"pack.json": ${manifestResolved.problem}`)] };

  const manifestDoc = await readJsonDocument(manifestResolved.real, "pack.json");
  if (!manifestDoc.ok) return { ok: false, errors: [packError(CODE.PACK_MANIFEST_UNREADABLE, "pack.json", "", manifestDoc.message)] };
  const manifestProblems = schemaErrors(manifestDoc.value, validatePackManifest, "pack.json", CODE.PACK_MANIFEST_INVALID);
  if (manifestProblems.length) return { ok: false, errors: manifestProblems };
  const manifest = manifestDoc.value;

  // The units file and the BPMN files are independent of each other: check
  // both even when one of them fails, so preflight reports everything at once.
  const errors = [];
  let units = null;
  const unitsResolved = await resolveInside(root, manifest.unitsFile);
  if (unitsResolved.escape) errors.push(packError(CODE.PACK_UNITS_ESCAPE, manifest.unitsFile, "", `"${manifest.unitsFile}" resolves outside the pack directory`));
  else if (unitsResolved.missing) errors.push(packError(CODE.PACK_UNITS_UNREADABLE, manifest.unitsFile, "", `"${manifest.unitsFile}" does not exist in the pack directory`));
  else if (unitsResolved.problem) errors.push(packError(CODE.PACK_UNITS_UNREADABLE, manifest.unitsFile, "", `"${manifest.unitsFile}": ${unitsResolved.problem}`));
  else {
    const unitsDoc = await readJsonDocument(unitsResolved.real, manifest.unitsFile);
    if (!unitsDoc.ok) errors.push(packError(CODE.PACK_UNITS_UNREADABLE, manifest.unitsFile, "", unitsDoc.message));
    else {
      const unitsProblems = schemaErrors(unitsDoc.value, validateUnits, manifest.unitsFile, CODE.PACK_UNITS_INVALID);
      if (unitsProblems.length) errors.push(...unitsProblems);
      else units = unitsDoc.value;
    }
  }

  const workflows = [];
  for (const [index, workflow] of manifest.workflows.entries()) {
    const contents = await checkWorkflowBpmn(workflow, index, root, errors);
    if (contents) workflows.push(contents);
  }

  checkManifestReferences(manifest, errors);
  if (units) checkUnitTree(units.units, new Set(manifest.unitTypes.map(unitType => unitType.id)), errors);

  if (errors.length) return { ok: false, errors };
  return { ok: true, pack: { manifest, units, workflows } };
}
