// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Types of the public pack projection served by `GET /api/pack` — the
 * whitelisted view of the installed industry pack (see server/pack-projection.mjs
 * and docs/PACK_FORMAT.md). The projection carries the pack's own presentation:
 * labels, record types, role groups, unit types, forms, decisions, deadlines
 * and the BPMN source of every workflow. It carries no user data and no
 * install-time fixtures; every value below comes from the pack manifest.
 */

export interface PackInfo {
  id: string;
  name: string;
  description?: string;
  version: string;
  language: string;
}

export interface PackGroup {
  id: string;
  name: string;
}

export interface PackUnitType {
  id: string;
  name: string;
}

export interface PackRecordType {
  id: string;
  name: string;
  description?: string;
}

export type PackFieldType = "text" | "text-multiline" | "number" | "date" | "select" | "file";

export interface PackFormField {
  id: string;
  label: string;
  type: PackFieldType;
  required?: boolean;
  options?: readonly string[];
}

export interface PackForm {
  fields: readonly PackFormField[];
}

export type PackOutcome = "approve" | "reject" | "forward" | "request-info";

export interface PackDecision {
  id: string;
  label: string;
  outcome: PackOutcome;
  requiresReason?: boolean;
}

export interface PackStep {
  id: string;
  name: string;
  role: string;
  unitTypes: readonly string[];
  /** Calendar days the step may take at most, from the moment it opens (UTC). */
  deadlineDays: number;
  form?: PackForm;
  decisions: readonly PackDecision[];
}

/** One business node of the workflow diagram, projected on the server from the BPMN (attributes only, no XML). */
export interface PackDiagramNode {
  id: string;
  name: string;
  kind: "start" | "task" | "gateway" | "end";
  /** Flowable candidate groups of a task node (public role groups of the pack). */
  groups?: readonly string[];
}

/** One sequence-flow edge; `label` is the user-facing decision label of a gateway branch, when the server could resolve it. */
export interface PackDiagramEdge {
  from: string;
  to: string;
  label?: string;
}

/** The structured diagram of a workflow: all nodes, all edges, and the happy path walked from the start event. */
export interface PackDiagram {
  nodes: readonly PackDiagramNode[];
  edges: readonly PackDiagramEdge[];
  path: readonly string[];
}

export interface PackWorkflow {
  id: string;
  name: string;
  description?: string;
  recordType: string;
  senderUnitTypes: readonly string[];
  receiverUnitTypes: readonly string[];
  senderGroups: readonly string[];
  receiverGroups: readonly string[];
  open: { role: string; form: PackForm };
  steps: readonly PackStep[];
  /** The workflow's business flow as public nodes and labelled edges; the raw BPMN never leaves the server. */
  diagram: PackDiagram;
}

export interface PackProjection {
  pack: PackInfo;
  groups: readonly PackGroup[];
  unitTypes: readonly PackUnitType[];
  recordTypes: readonly PackRecordType[];
  workflows: readonly PackWorkflow[];
}
