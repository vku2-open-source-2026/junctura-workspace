// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

import { actorIdsOf, workflowKeys, waitsForActor } from "../pack/data";

/**
 * Engine shapes the desk reads, plus the pack-fed matching. The desk shows no
 * workflow list of its own: which workflows exist, which staff may open and
 * which labels they carry all come from the pack projection.
 */

/** One execution in the workflow history list (newest first, at most 100 per page). */
export interface ExecutionItem {
  id: string;
  definition: { id: string; key: string; name: string; version: number };
  status: "running" | "completed" | "cancelled";
  startedAt?: string | null;
  updatedAt?: string | null;
  title?: string | null;
  currentStep?: { name: string; assignee?: string | null; groups?: readonly string[] } | null;
  /** The engine history list does not return the input; read from the detail when needed. */
  input?: Record<string, unknown> & { openedBy?: unknown };
}

export interface ExecutionList {
  items: readonly ExecutionItem[];
  limit?: number;
}

/** One definition line of the workflow summary, with per-status counts. */
export interface SummaryDefinition {
  key: string;
  name: string;
  application: { id: string; name: string } | null;
  steps: readonly { name: string; owner: string | null }[];
  counts: { running: number; completed: number; cancelled: number };
  updatedAt?: string | null;
}

export interface WorkflowSummary {
  definitions: readonly SummaryDefinition[];
  totals: { definitions: number; running: number; completed: number; cancelled: number };
}

/** A deployed definition version as listed by the engine. */
export interface DefinitionItem {
  id: string;
  key: string;
  version: number;
  name: string;
}

/** The durable engine record of one execution; `input` is what the opener sent. */
export interface ExecutionDetail {
  id: string;
  definitionId: string;
  status: "running" | "completed" | "cancelled";
  input?: Record<string, unknown>;
}

/** The latest deployed definition per workflow key: the highest version wins, whatever the list order. */
export const latestDefinitionBy = (items: readonly DefinitionItem[]): Readonly<Record<string, DefinitionItem>> => {
  const byKey: Record<string, DefinitionItem> = {};
  for (const item of items) {
    const known = byKey[item.key];
    if (!known || Number(item.version) > Number(known.version)) byKey[item.key] = item;
  }
  return byKey;
};

/** True when a running execution waits at a step naming any of the staff's actor ids. */
export const waitsForStaff = (
  item: ExecutionItem,
  staff: { facility: string; groups: readonly string[] },
): boolean => waitsForActor(item, actorIdsOf(staff));

/** True when the case's workflow is one the pack declares. */
export const isPackKey = (pack: Parameters<typeof workflowKeys>[0] | null, key: string): boolean =>
  pack != null && workflowKeys(pack).has(key);

// ---------------------------------------------------------------- shapes of the gateway

/** An author of a notice, note or uploaded file, as the gateway reports it. */
export interface Author {
  displayName: string;
  facility: string;
}

/** One notice of the bulletin board, newest first in the list response. */
export interface Notice {
  id: string;
  title: string;
  body: string;
  author: Author;
  createdAt: string;
}

export interface NoticeList {
  items: readonly Notice[];
}

/** One exchange note of a case, oldest first in the list response. */
export interface CaseNote {
  id: string;
  executionId: string;
  text: string;
  author: Author;
  createdAt: string;
}

export interface NoteList {
  items: readonly CaseNote[];
}

/** Metadata of one attachment of a case, oldest first in the list response. */
export interface FileMeta {
  id: string;
  executionId: string;
  name: string;
  type: string;
  bytes: number;
  author: Author;
  createdAt: string;
}

export interface FileList {
  items: readonly FileMeta[];
}
