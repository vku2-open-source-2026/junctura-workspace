// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Staff identity of the portal backend, resolved from the DX-OS Directory: the
// implemented `GET /v1/identity` (Foundation contract, `getVerifiedIdentity`)
// is called with the caller's own user bearer token, so the answer is the
// caller's verified membership. Never the app-scoped SDK `identity()` — that
// authenticates as the application — and never an admin Directory list: there
// is no fallback. The portal unit is the caller's verified unit of the
// expected tenant; a caller of several units must name one explicitly
// (`?unit=`), honoured only when the verified membership contains it, and
// everything else fails closed without depending on any order. No fixed list
// of unit ids is baked in: any verified unit of the tenant is a portal unit,
// so staff of any sector sign in through their own verified membership; a
// deployment may still restrict the accepted units with `facilities`. The
// token itself is bound to the answer: the verified local `sub` must be
// nonempty and must equal the response `subject` exactly — a mismatch is
// forbidden and grants no membership or access. Each `unitPaths` entry must
// pair the exact `/{tenantId}/{unit}` path with an advertised unit id; a
// contradictory upstream response is malformed, not authority. Errors
// separate authorization — no staff, wrong tenant, upstream 401/403 — from an
// unusable upstream answer (malformed body or unreachable core), which is 503
// like every other DX-OS dependency.
const UNIT = /^[a-z][a-z0-9-]{1,63}$/;
const UNIT_PATH = /^\/[a-z][a-z0-9-]{0,62}\/[a-z][a-z0-9-]{1,63}$/;
const GROUP_PATH = /^\/[a-z][a-z0-9-]{1,63}\/[a-z][a-z0-9-]{1,63}$/;

/**
 * Publication right of the board: the verified group `ban-tin` of the
 * selected unit `so-y-te`, so mere membership of `so-y-te` is not enough to
 * write (provisioning grants it deliberately). Kept exactly as issue #9
 * defined it; any broader board policy is separate work.
 */
export const BOARD_GROUP = "ban-tin";

const fail = (status, code) => ({ ok: false, status, code });
const isText = value => typeof value === "string" && value.length > 0;

/**
 * Every advertised unit pairs with its exact `/{tenantId}/{unit}` path in
 * `unitPaths` and nothing else is advertised there: a response whose paths
 * contradict the membership ids is malformed.
 */
function pairsUnitPaths(identity) {
  const paths = new Map(identity.unitPaths.map(item => [item.id, item.path]));
  return paths.size === identity.unitPaths.length && paths.size === identity.units.length
    && identity.units.every(unit => paths.get(unit) === `/${identity.tenantId}/${unit}`);
}

/** The `VerifiedIdentity` shape of the pinned Foundation contract, nothing more. */
export function isVerifiedIdentity(identity) {
  return identity !== null && typeof identity === "object" && !Array.isArray(identity)
    && isText(identity.subject) && isText(identity.tenantId)
    && Array.isArray(identity.roles) && identity.roles.every(isText) && identity.roles.includes("core-reader")
    && Array.isArray(identity.units) && identity.units.every(unit => typeof unit === "string" && UNIT.test(unit))
    && Array.isArray(identity.unitPaths) && identity.unitPaths.every(item =>
      item !== null && typeof item === "object" && !Array.isArray(item)
      && typeof item.id === "string" && UNIT.test(item.id)
      && typeof item.path === "string" && UNIT_PATH.test(item.path))
    && pairsUnitPaths(identity)
    && Array.isArray(identity.groups) && identity.groups.every(group => typeof group === "string" && GROUP_PATH.test(group))
    && (identity.preferredUsername === undefined
      || (isText(identity.preferredUsername) && [...identity.preferredUsername].length <= 255));
}

/**
 * An async `staffFor(token, claims, requestedUnit)` over the Directory. The
 * outcome is `{ ok, staff }` or `{ ok: false, status, code }`; `requestedUnit`
 * (`null` when absent) is an explicit selection of a verified unit. `claims`
 * are the verified token claims: a nonempty `sub` bound exactly to the
 * response `subject` is required before any membership is granted.
 */
export function createStaffFor({ expectedTenant, fetchIdentity, facilities = null, boardGroup = BOARD_GROUP } = {}) {
  if (!isText(expectedTenant) || typeof fetchIdentity !== "function") throw new TypeError("expectedTenant and fetchIdentity are required");
  return async function staffFor(token, claims, requestedUnit = null) {
    const sub = isText(claims?.sub) ? claims.sub : null;
    if (!sub) return fail(403, "forbidden");
    const username = isText(claims?.preferred_username) ? claims.preferred_username : null;
    if (!username) return fail(403, "forbidden");
    const answer = await fetchIdentity(token);
    const status = answer?.status;
    if (status === 401) return fail(401, "unauthorized");
    if (status === 403 || status === 404) return fail(403, "forbidden");
    if (status !== 200 || !isVerifiedIdentity(answer.body)) return fail(503, "junctura_unavailable");
    const identity = answer.body;
    if (identity.tenantId !== expectedTenant) return fail(403, "forbidden");
    if (identity.subject !== sub) return fail(403, "forbidden");
    let facility;
    if (requestedUnit !== null) {
      if (typeof requestedUnit !== "string" || !UNIT.test(requestedUnit)) return fail(400, "invalid_input");
      if (!identity.units.includes(requestedUnit)) return fail(403, "forbidden");
      if (facilities != null && !facilities.has(requestedUnit)) return fail(403, "forbidden");
      facility = requestedUnit;
    } else {
      const known = facilities == null ? identity.units : identity.units.filter(unit => facilities.has(unit));
      if (known.length !== 1) return fail(403, "forbidden");
      facility = known[0];
    }
    return {
      ok: true,
      staff: {
        username,
        displayName: isText(identity.preferredUsername) ? identity.preferredUsername : username,
        facility,
        // The verified group paths (`/{unit}/{group}`) of the caller, as the
        // Directory reports them. `GET /api/me` passes them to the frontend,
        // which matches their last segment against the role groups of the
        // installed pack (`groups[].id`).
        groups: [...identity.groups],
        canPublish: facility === "so-y-te" && identity.groups.includes(`/${facility}/${boardGroup}`),
      },
    };
  };
}
