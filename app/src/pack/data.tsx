// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { PackDiagram, PackDiagramNode, PackFormField, PackProjection, PackWorkflow } from "./types";

export type { PackDiagram, PackDiagramNode, PackProjection, PackStep, PackWorkflow } from "./types";

/**
 * Presentation helpers over the pack projection. Everything here is pure: the
 * same pack in, the same views out. The pages never import a pack statically —
 * the projection arrives at runtime, so one built bundle can present any pack
 * the backend is configured to serve. The workflow diagrams come from the
 * server as structured public nodes and edges; no BPMN is parsed in the
 * browser and no raw XML is ever shipped.
 */

// ---------------------------------------------------------------- lookups and labels

export const workflowOf = (pack: PackProjection, key: string): PackWorkflow | undefined =>
  pack.workflows.find(workflow => workflow.id === key);

export const recordTypeOf = (pack: PackProjection, id: string) =>
  pack.recordTypes.find(recordType => recordType.id === id);

/** The workflows of one record type, in manifest order. */
export const workflowsOfRecordType = (pack: PackProjection, recordTypeId: string): readonly PackWorkflow[] =>
  pack.workflows.filter(workflow => workflow.recordType === recordTypeId);

/**
 * The friendly name of a pack identifier: a role group, else a unit type, else
 * the raw id (unknown identifiers stay readable instead of disappearing).
 * While no pack is loaded the raw id passes through unchanged.
 */
export const labelOf = (pack: PackProjection | null) => (id: string): string =>
  pack?.groups.find(group => group.id === id)?.name
  ?? pack?.unitTypes.find(unitType => unitType.id === id)?.name
  ?? id;

/** The workflow keys of the pack, as a set for cheap membership checks. */
export const workflowKeys = (pack: PackProjection): ReadonlySet<string> =>
  new Set(pack.workflows.map(workflow => workflow.id));

// ---------------------------------------------------------------- staff matching

/**
 * The pack role groups of the SELECTED verified unit only. A Directory group
 * of another verified unit (`/{other-unit}/{group}`) never grants actions
 * here, whatever its last segment matches in the pack.
 */
export const unitGroupIds = (staff: { facility: string; groups: readonly string[] }): readonly string[] =>
  staff.groups
    .filter(group => group.startsWith(`/${staff.facility}/`))
    .map(group => group.split("/").filter(Boolean).at(-1) ?? "")
    .filter(Boolean);

/**
 * Everything a staff member can act as on the selected unit: the unit itself
 * (the engine names it in candidate groups) and the pack role groups verified
 * for exactly that unit.
 */
export const actorIdsOf = (staff: { facility: string; groups: readonly string[] }): readonly string[] => [
  staff.facility,
  ...unitGroupIds(staff),
];

/** The workflows the staff may open: `open.role` is one of the selected unit's verified groups. Empty while no pack is loaded. */
export const openableWorkflows = (pack: PackProjection | null, staff: { facility: string; groups: readonly string[] }): readonly PackWorkflow[] => {
  if (pack == null) return [];
  const groups = new Set(unitGroupIds(staff));
  return pack.workflows.filter(workflow => groups.has(workflow.open.role));
};

/** True when a running execution waits at a step naming any of `actorIds` as candidate group. */
export const waitsForActor = (item: { status: string; currentStep?: { groups?: readonly string[] } | null }, actorIds: readonly string[]): boolean =>
  item.status === "running" && (item.currentStep?.groups ?? []).some(group => actorIds.includes(group));

// ---------------------------------------------------------------- forms

/** A short reference-code prefix derived from a pack workflow id, e.g. `chuyen-tuyen` → `CH-`. */
export const referencePrefix = (workflowId: string): string =>
  `${workflowId.replace(/[^a-z0-9]/g, "").slice(0, 2).toUpperCase()}-`;

/** A reference code of a case title, e.g. `CH-ABC123`: uppercase, digits and dashes. */
export const REFERENCE_PATTERN = /^[A-Z][A-Z0-9-]{0,31}$/;

/**
 * Builds a fresh reference code from a prefix (e.g. `CH-`) plus six random alphanumerics,
 * so two runs almost never collide and the value always matches {@link REFERENCE_PATTERN}.
 */
export const generateReference = (prefix: string): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = new Uint32Array(6);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return prefix + code;
};

/** The kind labels of diagram nodes that carry no name of their own. */
const KIND_LABELS: Readonly<Record<string, string>> = {
  start: "Bắt đầu",
  gateway: "Rẽ nhánh",
  end: "Kết thúc",
};

/** The label of a diagram node: its own name, else the element kind, else the id. */
export const nodeLabel = (node: PackDiagramNode): string => node.name || KIND_LABELS[node.kind] || node.id;

/** The outgoing edges of a diagram node, in projection order. */
export const edgesFrom = (diagram: PackDiagram, nodeId: string) =>
  diagram.edges.filter(edge => edge.from === nodeId);

/** The label of a diagram edge: the resolved decision label, else the target node's name. */
export const edgeLabel = (diagram: PackDiagram, edge: { from: string; to: string; label?: string }): string =>
  edge.label ?? nodeLabel(diagram.nodes.find(node => node.id === edge.to) ?? { id: edge.to, name: "", kind: "end" });

/** The form fields of a pack form, in manifest order. */
export const fieldsOf = (form: PackFormField[] | { fields: readonly PackFormField[] } | undefined): readonly PackFormField[] =>
  form == null ? [] : "fields" in form ? form.fields : [];

// ---------------------------------------------------------------- projection loading

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Minimal shape check of a `/api/pack` answer; anything else is unusable. */
export function isPackProjection(value: unknown): value is PackProjection {
  if (!isRecord(value)) return false;
  const { pack, groups, unitTypes, recordTypes, workflows } = value;
  return isRecord(pack) && typeof pack.id === "string" && typeof pack.name === "string"
    && Array.isArray(groups) && groups.every(isRecord)
    && Array.isArray(unitTypes) && unitTypes.every(isRecord)
    && Array.isArray(recordTypes) && recordTypes.every(isRecord)
    && Array.isArray(workflows) && workflows.every(isRecord);
}

/** Reads the pack projection from the portal backend's public route. */
export async function loadPackProjection(fetchJson: typeof fetch = fetch): Promise<PackProjection> {
  const response = await fetchJson("api/pack", { cache: "no-store" });
  if (!response.ok) throw new Error(`pack ${response.status}`);
  const value = await response.json();
  if (!isPackProjection(value)) throw new Error("pack_projection_invalid");
  return value;
}

// ---------------------------------------------------------------- context

export interface PackState {
  pack: PackProjection | null;
  /** True when the projection could not be loaded: the pages show a visible failure, never an endless loading state. */
  failed: boolean;
}

/** The raw context, exported for tests that seed a specific pack. */
export const PackContext = createContext<PackState>({ pack: null, failed: false });

/**
 * Provides the active pack projection to the whole portal. The projection is
 * fetched once per page load from the public `GET /api/pack`; while it loads
 * `pack` is null and the pages render their loading states, and when it fails
 * `failed` turns true so the pages show a visible error instead of waiting.
 */
export function PackProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<PackState>({ pack: null, failed: false });
  useEffect(() => {
    let live = true;
    loadPackProjection().then(value => {
      if (live) setState({ pack: value, failed: false });
    }).catch(() => {
      if (live) setState({ pack: null, failed: true });
    });
    return () => { live = false; };
  }, []);
  const value = useMemo(() => state, [state]);
  return <PackContext.Provider value={value}>{children}</PackContext.Provider>;
}

/** The active pack projection, or null while it is loading (or unavailable). */
export function usePack(): PackProjection | null {
  return useContext(PackContext).pack;
}

/** The load state of the pack projection: which pages separate loading from a visible failure. */
export function usePackState(): PackState {
  return useContext(PackContext);
}
