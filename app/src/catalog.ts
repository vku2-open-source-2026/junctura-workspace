// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The case-type library: views of the record types of the active pack, built
 * from the pack projection served by `GET /api/pack`. Each type exposes its
 * workflows with the BPMN diagram, the open form, the allowed role groups and
 * unit types, and the per-step SLA — all of it pack-declared presentation, no
 * user data. Pure and synchronous: the same pack in, the same views out.
 */

import { fieldsOf, workflowsOfRecordType, type PackProjection, type PackStep, type PackWorkflow } from "./pack/data";
import type { PackDiagram, PackFormField } from "./pack/types";

/** One line of the library list: a record type of the pack and how many workflows implement it. */
export interface RecordTypeEntry {
  id: string;
  name: string;
  description?: string;
  workflowCount: number;
}

/** The library list, in the pack's record-type order. */
export const recordTypeCatalog = (pack: PackProjection): readonly RecordTypeEntry[] =>
  pack.recordTypes.map(recordType => ({
    id: recordType.id,
    name: recordType.name,
    ...(recordType.description ? { description: recordType.description } : {}),
    workflowCount: workflowsOfRecordType(pack, recordType.id).length,
  }));

// ---------------------------------------------------------------- detail views

export interface FormFieldView {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options: readonly string[];
}

export interface StepView {
  id: string;
  name: string;
  role: string;
  unitTypes: readonly string[];
  deadlineDays: number;
  fields: readonly FormFieldView[];
  decisions: readonly { id: string; label: string; outcome: string; requiresReason: boolean }[];
}

export interface RecordTypeWorkflowView {
  workflow: PackWorkflow;
  diagram: PackDiagram;
  openFields: readonly FormFieldView[];
  steps: readonly StepView[];
}

export interface RecordTypeDetail {
  id: string;
  name: string;
  description?: string;
  workflows: readonly RecordTypeWorkflowView[];
}

const fieldView = (field: PackFormField): FormFieldView => ({
  id: field.id,
  label: field.label,
  type: field.type,
  required: field.required === true,
  options: field.options ?? [],
});

const stepView = (step: PackStep): StepView => ({
  id: step.id,
  name: step.name,
  role: step.role,
  unitTypes: step.unitTypes,
  deadlineDays: step.deadlineDays,
  fields: fieldsOf(step.form).map(fieldView),
  decisions: step.decisions.map(decision => ({
    id: decision.id,
    label: decision.label,
    outcome: decision.outcome,
    requiresReason: decision.requiresReason === true,
  })),
});

/** The library detail of one record type; undefined for an id the pack does not declare. */
export function recordTypeDetail(pack: PackProjection, id: string): RecordTypeDetail | undefined {
  const recordType = pack.recordTypes.find(candidate => candidate.id === id);
  if (!recordType) return undefined;
  return {
    id: recordType.id,
    name: recordType.name,
    ...(recordType.description ? { description: recordType.description } : {}),
    workflows: workflowsOfRecordType(pack, id).map(workflow => ({
      workflow,
      diagram: workflow.diagram,
      openFields: fieldsOf(workflow.open.form).map(fieldView),
      steps: workflow.steps.map(stepView),
    })),
  };
}
