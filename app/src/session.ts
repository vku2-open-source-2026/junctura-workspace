// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Staff identity of the signed-in workspace, resolved by the backend from the
 * caller's verified Directory membership (`GET /api/me` — see server/staff.mjs).
 * The frontend keeps no account fixture of its own: a signed-in user is staff
 * exactly when the backend answers, and the returned facility and groups are
 * the ones the portal works with.
 */

export interface Staff {
  username: string;
  displayName: string;
  /** The verified unit of the caller, as the Directory advertises it. */
  facility: string;
  /** The verified group paths (`/{unit}/{group}`) of the caller. */
  groups: readonly string[];
  /** True when the caller may publish to the shared bulletin board. */
  canPublish: boolean;
}

const isText = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** Validates a `/api/me` answer; anything else is unusable and means "not staff". */
export function staffFromMe(value: unknown): Staff | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const { username, displayName, facility, groups, canPublish } = value as Record<string, unknown>;
  if (!isText(username) || !isText(displayName) || !isText(facility)) return null;
  if (!Array.isArray(groups) || !groups.every(isText)) return null;
  if (typeof canPublish !== "boolean") return null;
  return { username, displayName, facility, groups, canPublish };
}

/**
 * The staff profile for a signed-in session, or null when the account is not
 * staff of this portal. Fetch errors surface through the caller.
 */
export async function fetchStaffProfile(getJson: (path: string) => Promise<unknown>): Promise<Staff | null> {
  return staffFromMe(await getJson("/api/me"));
}
