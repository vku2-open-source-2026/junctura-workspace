// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Public pack projection of the portal: the safe, whitelisted view of an
// installed industry pack that `GET /api/pack` serves to the browser.
//
// The projection is intentionally public and read-only (see docs/PORTAL.md,
// "Dữ liệu công khai của gói"): a pack manifest is, by design of the pack
// format (docs/PACK_FORMAT.md), the shared configuration of a sector — labels,
// record types, role groups, forms, decisions and deadlines — exactly what the
// public case-type library used to build from a private checkout. It contains
// no user data. What is deliberately kept out:
//   - `units.json` sample units (an install fixture of `pack:install`, never
//     presented on any endpoint);
//   - every manifest field outside the whitelist below, so later private
//     additions to the format can never leak through this endpoint;
//   - anything about the caller: the route runs without authentication and
//     never sees a token.
// Staff identity, cases, notices, notes and files keep their authenticated
// routes untouched; only this pack presentation is public. The BPMN of a
// workflow is never shipped raw: the projection carries a structured diagram
// (public nodes and edges, gateway branches labelled with the manifest's
// user-facing decision labels) built by bpmn-diagram.mjs, so documentation
// notes and condition expressions of the XML stay private.
import { diagramOf } from "./bpmn-diagram.mjs";
import { readPack } from "./packs.mjs";

const FORM_FIELD = field => ({
  id: field.id,
  label: field.label,
  type: field.type,
  ...(field.required === true ? { required: true } : {}),
  ...(Array.isArray(field.options) ? { options: field.options } : {}),
});

const FORM = form => ({ fields: form.fields.map(FORM_FIELD) });

const DECISION = decision => ({
  id: decision.id,
  label: decision.label,
  outcome: decision.outcome,
  ...(decision.requiresReason === true ? { requiresReason: true } : {}),
});

/**
 * The whitelisted projection of one pack already validated by `readPack`
 * (`{ manifest, units, workflows }`). Pure: same input, same output.
 */
export function projectPack(pack) {
  const { manifest, workflows } = pack;
  return {
    pack: {
      id: manifest.id,
      name: manifest.name,
      ...(manifest.description ? { description: manifest.description } : {}),
      version: manifest.version,
      language: manifest.language,
    },
    groups: manifest.groups.map(group => ({ id: group.id, name: group.name })),
    unitTypes: manifest.unitTypes.map(unitType => ({ id: unitType.id, name: unitType.name })),
    recordTypes: manifest.recordTypes.map(recordType => ({
      id: recordType.id,
      name: recordType.name,
      ...(recordType.description ? { description: recordType.description } : {}),
    })),
    workflows: manifest.workflows.map((workflow, index) => ({
      id: workflow.id,
      name: workflow.name,
      ...(workflow.description ? { description: workflow.description } : {}),
      recordType: workflow.recordType,
      senderUnitTypes: [...workflow.senderUnitTypes],
      receiverUnitTypes: [...workflow.receiverUnitTypes],
      senderGroups: [...workflow.senderGroups],
      receiverGroups: [...workflow.receiverGroups],
      open: { role: workflow.open.role, form: FORM(workflow.open.form) },
      steps: workflow.steps.map(step => ({
        id: step.id,
        name: step.name,
        role: step.role,
        unitTypes: [...step.unitTypes],
        deadlineDays: step.deadlineDays,
        ...(step.form ? { form: FORM(step.form) } : {}),
        decisions: step.decisions.map(DECISION),
      })),
      // The workflow's business flow as public nodes and labelled edges; no
      // raw BPMN, no condition text, no documentation notes.
      diagram: diagramOf(workflows[index].xml, workflow.steps),
    })),
  };
}

/**
 * Reads one pack directory through the shared preflight reader and returns the
 * public projection. Throws with a readable summary when the pack is missing
 * or malformed: the backend refuses to start serving a broken pack.
 */
export async function readPackProjection(packDir) {
  const result = await readPack(packDir);
  if (!result.ok) {
    const summary = result.errors.map(error => `${error.code} at ${error.file}${error.path} — ${error.message}`).join("; ");
    throw new Error(`the pack at ${packDir} is not usable: ${summary}`);
  }
  return projectPack(result.pack);
}
