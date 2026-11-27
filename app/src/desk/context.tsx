// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext, useMemo, type ReactNode } from "react";

/**
 * The signed-in desk staff member, as `GET /api/me` resolved it from the
 * verified Directory membership: the unit they work for, the group paths their
 * membership carries, and whether they may publish to the bulletin board.
 * There is no client-side unit vocabulary — labels of units and role groups
 * come from the pack, and the ids are whatever the Directory verifies.
 */
export interface DeskStaff {
  username: string;
  displayName: string;
  facility: string;
  groups: readonly string[];
  canPublish: boolean;
}

/** Thin transport for the space pages; wiring lives in the app shell, not here. */
export interface DeskApi {
  getJson<T>(path: string): Promise<T>;
  postJson<T>(path: string, body?: unknown, opts?: { idempotencyKey?: string }): Promise<T | null>;
  /** GET a binary resource (e.g. an attachment of a case) as a Blob. */
  getBlob(path: string): Promise<Blob>;
  /** POST raw bytes with explicit headers (e.g. Content-Type and X-File-Name for uploads). */
  postBytes<T>(path: string, file: Blob, headers: Record<string, string>): Promise<T>;
}

/** API failures are thrown as plain objects carrying the HTTP status and Core error code. */
export interface DeskApiError {
  status: number;
  code: string | null;
}

export const isDeskApiError = (value: unknown): value is DeskApiError =>
  typeof value === "object" && value !== null && typeof (value as { status?: unknown }).status === "number";

interface DeskContextValue {
  api: DeskApi;
  staff: DeskStaff;
  signOut: () => void;
}

const DeskContext = createContext<DeskContextValue | null>(null);

export interface DeskProviderProps {
  staff: DeskStaff;
  api: DeskApi;
  signOut: () => void;
  children: ReactNode;
}

/** Provides the signed-in staff member, the API transport and sign-out to the desk pages. */
export const DeskProvider = ({ staff, api, signOut, children }: DeskProviderProps) => {
  const value = useMemo(() => ({ staff, api, signOut }), [staff, api, signOut]);
  return <DeskContext.Provider value={value}>{children}</DeskContext.Provider>;
};

/** The desk values; every desk page calls this, so it must sit under a DeskProvider. */
export function useDesk(): DeskContextValue {
  const value = useContext(DeskContext);
  if (!value) throw new Error("useDesk chỉ dùng được bên trong DeskProvider");
  return value;
}
