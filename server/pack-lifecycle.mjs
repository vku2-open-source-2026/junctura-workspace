// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Pack lifecycle execution for issue #12: real install and inspection of
// Workspace industry packs on a Junctura DX-OS stack. Explicit activation and
// safe retirement are deliberately NOT part of this slice: an independent
// review of the earlier candidate found a genuine unsafe cross-record
// selection/retirement race (a deterministic lock idempotency key replayable
// across processes, and a post-commit repair able to clear an unrelated later
// selection), so every selection/activation/retirement code path was removed
// here. The next slice is expected to implement transaction-backed selection
// and retire over the pinned /v2/data:batch operation with the chosen active
// state protected; until then nothing selects or retires, and this module is
// the install-state foundation.
//
// The publication contract is the one independently verified in Junctura DX-OS
// PR #113 (merged at bb6233f86633a42e1e1e5f58812a53064e6cd9b0; release
// verification is separate): POST
// /v1/workflows/definitions with body {"xml": …} and a lowercase-UUID
// Idempotency-Key, published only by a verified direct tenant console-admin
// (junctura-console console-admin plus core-writer, never a delegated actor or a
// plain backend), tenant always derived from the verified identity. 201 new,
// 200 identical replay, 409 idempotency_conflict for changed content under the
// same key, 409 deployment_pending_reconciliation while another request holds
// the reservation (retry the same key after reconciliation), 503
// workflow_unavailable after an ambiguous engine outcome (the same key replays
// from the deployed resource). Directory writes are desired-state PUTs at named
// keys (putDirectoryUnitType/putDirectoryUnit/putDirectoryGroup); reads go
// through the pinned list contracts — the exact unit route pins PUT only, so a
// unit is looked up by its exact id across the paginated GET
// /v1/directory/units listing before any of its writes.
//
// Pack state lives in one DX-OS record collection owned by the registered
// backend application (registerCollectionSchema, by-key upsert with the pinned
// If-Match/412/428/422 semantics):
//   - `ws_packs`, one record per installed pack version with the durable
//     reservation of the install: created with status "installing" BEFORE any
//     Directory or workflow effect, finalized to "available" with an
//     If-Match-conditional by-key replace only after every effect committed. A
//     partially applied install therefore never becomes available, and a
//     simultaneous pack with the same version but different content loses on
//     the reservation before it performs any effect.
//
// Nothing is ever stored in a local database, seed or generated state file, and
// every write body is deterministic (no local timestamps — Core supplies
// created_at metadata), so a rerun after any uncertain outcome reuses exactly
// the same request keys and bodies. The run never picks a fresh key after an
// ambiguous outcome; it stops and tells the operator to rerun the same command.
//
// Core stays authoritative about business BPMN at deployment: this module
// reuses the shared namespace-aware pack reader (readPack, executed by the
// planner that produces the plan consumed here) and checks only the pinned
// definition-key shape and byte cap offline. A 400 definition_invalid at
// publish time is reported; the reservation then stays incomplete and safe.
import { createHash } from "node:crypto";
import { createJuncturaClient, JuncturaError } from "@junctura/server-client";

/** DX-OS record collection holding one durable reservation per installed pack version. */
export const WS_PACKS_COLLECTION = "ws_packs";

/**
 * The documented ws_packs collection schema. Field names follow the pinned
 * RecordField pattern ^[A-Za-z_][A-Za-z0-9_]{0,63}$; every `pattern` uses only
 * the PostgreSQL-safe subset of the pinned schema validation (ascii literals,
 * character classes, anchors and single-atom quantifiers — no grouping,
 * alternation or backreferences; an unescaped hyphen sits last in its class).
 * The version field deliberately re-declares NO length bound and NO semantic
 * version format: the pack manifest schema (pack.schema.json) bounds versions
 * by pattern alone, so every manifest-safe version — including long
 * prereleases — fits the record, and anything unorderable is refused by the
 * comparator before it is used.
 */
export const WS_PACKS_SCHEMA = Object.freeze({
  schema: Object.freeze({
    type: "object",
    required: ["key", "packId", "version", "status", "contentHash", "definitions", "directory"],
    properties: {
      key: { type: "string", pattern: "^[A-Za-z0-9_-]{1,128}$" },
      packId: { type: "string", pattern: "^[a-z][a-z0-9-]{0,62}$" },
      version: { type: "string", pattern: "^[0-9A-Za-z.-]+$" },
      status: { type: "string", enum: ["installing", "available", "retired"] },
      contentHash: { type: "string", pattern: "^[0-9a-f]{64}$" },
      definitions: {
        type: "array",
        items: {
          type: "object",
          required: ["workflow", "key"],
          properties: {
            workflow: { type: "string", pattern: "^[a-z][a-z0-9_]{2,63}$" },
            key: { type: "string", pattern: "^[a-z][a-z0-9_]{2,63}$" },
            definitionId: { type: "string", minLength: 1 },
            definitionVersion: { type: "integer", minimum: 1 },
          },
        },
      },
      directory: {
        type: "object",
        required: ["unitTypes", "units", "groups"],
        properties: {
          unitTypes: { type: "array", items: { type: "string", pattern: "^[a-z][a-z0-9-]{1,63}$" } },
          units: { type: "array", items: { type: "string", pattern: "^[a-z][a-z0-9-]{1,63}$" } },
          groups: {
            type: "array",
            items: {
              type: "object",
              required: ["unit", "group"],
              properties: {
                unit: { type: "string", pattern: "^[a-z][a-z0-9-]{1,63}$" },
                group: { type: "string", pattern: "^[a-z][a-z0-9-]{1,63}$" },
              },
            },
          },
        },
      },
    },
  }),
  indexed: ["packId", "version", "status", "key"],
  uniqueKey: "key",
  searchable: [],
  sensitive: [],
});

/** Stable machine-readable codes of `PackLifecycleError`. */
export const PackLifecycleErrorCode = Object.freeze({
  LIFECYCLE_CONFIG_MISSING: "LIFECYCLE_CONFIG_MISSING",
  OPERATOR_IDENTITY_REJECTED: "OPERATOR_IDENTITY_REJECTED",
  BACKEND_IDENTITY_REJECTED: "BACKEND_IDENTITY_REJECTED",
  PLAN_INVALID: "PLAN_INVALID",
  VERSION_NOT_GREATER: "VERSION_NOT_GREATER",
  VERSION_CONTENT_MISMATCH: "VERSION_CONTENT_MISMATCH",
  RECORD_IDEMPOTENCY_CONFLICT: "RECORD_IDEMPOTENCY_CONFLICT",
  RECORD_SCOPE_MISMATCH: "RECORD_SCOPE_MISMATCH",
  RECORD_PRECONDITION: "RECORD_PRECONDITION",
  DEFINITION_CONFLICT: "DEFINITION_CONFLICT",
  DEFINITION_POLICY_INVALID: "DEFINITION_POLICY_INVALID",
  PENDING_NOT_SETTLED: "PENDING_NOT_SETTLED",
  DIRECTORY_SCOPE_MISMATCH: "DIRECTORY_SCOPE_MISMATCH",
  UPSTREAM_REJECTED: "UPSTREAM_REJECTED",
});

const CODE = PackLifecycleErrorCode;

/** The pinned uniqueKey shape of a by-key path. */
const UNIQUE_KEY = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The stable record `key` of one installed pack version. The mapping is
 * injective: characters outside the pinned uniqueKey pattern never occur in a
 * pack version except ".", which maps to "_" (a version never contains "_"),
 * so no two legitimate versions (including prereleases such as 1.2.3-rc.1 and
 * 1.2.3-rc-1) can share a key. Keys longer than the pinned 128 characters use
 * a hash of the full mapped version; the exact version always travels in the
 * record and is verified on every read.
 */
export function recordKeyFor(packId, version) {
  const mapped = `${packId}-${version.replaceAll(".", "_")}`;
  if (UNIQUE_KEY.test(mapped)) return mapped;
  return `${packId}-${createHash("sha256").update(mapped).digest("hex").slice(0, 32)}`;
}

/**
 * Comparison of the pinned pack version pattern X.Y.Z(-prerelease): the core
 * numbers compare numerically (BigInt, so arbitrarily large components keep
 * their order), a prerelease sorts before the release, and prerelease
 * identifiers split on dots compare numerically when both are numeric and
 * lexically otherwise, with numeric before alphanumeric and fewer identifiers
 * first — the semver rules the pack format references.
 */
export function compareVersions(left, right) {
  const parse = version => {
    const hyphen = version.indexOf("-");
    const core = hyphen === -1 ? version : version.slice(0, hyphen);
    const pre = hyphen === -1 ? null : version.slice(hyphen + 1);
    return { core: core.split(".").map(BigInt), ids: pre === null ? null : pre.split(".") };
  };
  const a = parse(left);
  const b = parse(right);
  if (a.core.length !== 3 || b.core.length !== 3 || a.core.some(Number.isNaN) || b.core.some(Number.isNaN)) {
    throw new TypeError(`not a pack version: ${a.core.length !== 3 || a.core.some(Number.isNaN) ? left : right}`);
  }
  for (const [index, value] of a.core.entries()) {
    if (value !== b.core[index]) return value < b.core[index] ? -1 : 1;
  }
  if (a.ids === null && b.ids === null) return 0;
  if (a.ids === null) return 1;
  if (b.ids === null) return -1;
  const length = Math.max(a.ids.length, b.ids.length);
  for (let index = 0; index < length; index++) {
    const x = a.ids[index];
    const y = b.ids[index];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) {
      const xn = BigInt(x);
      const yn = BigInt(y);
      if (xn !== yn) return xn < yn ? -1 : 1;
    } else if (xNumeric !== yNumeric) {
      return xNumeric ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** Canonical JSON (sorted object keys), the stable form hashed for pack content. */
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}

/** Stable digest over everything the install would publish: manifest, units and BPMN source. */
export function packContentHash(pack) {
  return createHash("sha256")
    .update(canonical({
      manifest: pack.manifest,
      units: pack.units,
      workflows: pack.workflows.map(workflow => ({ id: workflow.id, bpmn: workflow.bpmn, xml: workflow.xml })),
    }))
    .digest("hex");
}

/**
 * Deterministic UUID for one durable operation, derived from the seed
 * `tenant|packId|version|op[|workflowId]|content`: the SHA-256 digest is
 * formatted as a version-4 UUID, so the same operation always reserves the
 * same Idempotency-Key across processes and reruns.
 */
export function operationKey(seed) {
  const digest = createHash("sha256").update(seed).digest("hex");
  const chars = digest.slice(0, 32).split("");
  chars[14] = "4";
  chars[19] = ["8", "9", "a", "b"][parseInt(digest[32], 16) & 3];
  const hex = chars.join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The readable seed of one operation; the exact key derivation of the builder below. */
export const operationSeed = (tenant, packId, version, op, workflowId, content) =>
  [tenant, packId, version, op, workflowId ?? "", content ?? ""].join("|");

/**
 * Lifecycle failure. `uncertain` marks outcomes where the network result is
 * unknown or the reservation is still pending: the only safe next step is to
 * rerun the same command so the same request keys and bodies replay. A fresh
 * key is never picked automatically.
 */
export class PackLifecycleError extends Error {
  constructor(code, { message, uncertain = false, problems, cause } = {}) {
    super(message ?? code);
    this.name = "PackLifecycleError";
    this.code = code;
    this.uncertain = uncertain;
    this.problems = problems;
    if (cause !== undefined) this.cause = cause;
  }
}

const TRANSIENT = new Set([0, 429, 502, 503, 504]);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Error classification: transient outcomes may be retried, the rest stop the run. */
function classify(status) {
  if (TRANSIENT.has(status)) return "transient";
  return "rejected";
}

const uncertain = message => new PackLifecycleError(CODE.UPSTREAM_REJECTED, { message, uncertain: true });

/**
 * Bounded retry of one call: transient outcomes (network failure, 429, 502,
 * 503, 504) are retried with linear backoff; when the attempts are exhausted
 * the error is reported as uncertain — never as a reason to pick a different
 * request key.
 */
async function retrying(run, { attempts, delayMs }) {
  let last;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await run(attempt);
    } catch (error) {
      last = error;
      if (error?.uncertain !== true) throw error;
      if (attempt < attempts) await sleep(delayMs * attempt);
    }
  }
  throw last;
}

/** Maps an SDK request failure: transient statuses stay uncertain, the rest are definite. */
function upstreamError(what, error) {
  if (error instanceof JuncturaError && classify(error.status) === "transient") {
    return uncertain(`${what}: ${error.message}`);
  }
  return new PackLifecycleError(CODE.UPSTREAM_REJECTED, { message: `${what}: ${error.message}`, cause: error });
}

/**
 * The operator configuration (docs/PACK_FORMAT.md): the Gateway origin, the
 * tenant the pack is installed for, the registered backend application
 * credentials that own the pack records, and the direct tenant console-admin
 * bearer token for Directory and BPMN publication. The operator must also be
 * enrolled as a Directory manager with directory.write — a Core-side
 * enrollment bound to the verified subject, issuer and client, separate from
 * the console-admin role required for BPMN publication (Core source
 * infra/postgres/037-directory-management.sql, docs/CORE_API.md). Tokens are
 * read from the environment by the caller and are never logged or printed by
 * this module.
 */
export function readLifecycleConfig(env) {
  const required = (value, name) => {
    if (!value) throw new PackLifecycleError(CODE.LIFECYCLE_CONFIG_MISSING, { message: `${name} is required (see docs/PACK_FORMAT.md)` });
    return value;
  };
  return {
    baseUrl: required(env.JUNCTURA_URL, "JUNCTURA_URL").replace(/\/+$/, ""),
    tenant: required(env.JUNCTURA_TENANT, "JUNCTURA_TENANT"),
    backend: {
      clientId: required(env.JUNCTURA_APP_CLIENT_ID, "JUNCTURA_APP_CLIENT_ID"),
      clientSecret: required(env.JUNCTURA_APP_CLIENT_SECRET, "JUNCTURA_APP_CLIENT_SECRET"),
    },
    operatorToken: required(env.JUNCTURA_OPERATOR_TOKEN, "JUNCTURA_OPERATOR_TOKEN"),
  };
}

/**
 * Every mutating lifecycle command requires the intended verified direct
 * tenant console-admin (operator bearer) separately from the backend
 * application that owns the record writes — a plain backend identity alone
 * never grants management authority.
 */
export async function verifyOperatorIdentity(config) {
  let response;
  try {
    response = await fetch(new URL("/v1/identity", config.baseUrl), {
      headers: { authorization: `Bearer ${config.operatorToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new PackLifecycleError(CODE.OPERATOR_IDENTITY_REJECTED, { message: "the operator token could not be verified", uncertain: true });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new PackLifecycleError(CODE.OPERATOR_IDENTITY_REJECTED,
      { message: `the operator token was not verified (HTTP ${response.status})` });
  }
  const identity = await response.json().catch(() => null);
  if (identity?.tenantId !== config.tenant || identity.consoleRole !== "admin" ||
    !identity.roles?.includes("core-writer") || !identity.roles?.includes("core-reader")) {
    throw new PackLifecycleError(CODE.OPERATOR_IDENTITY_REJECTED,
      { message: "the operator token is not a verified direct tenant console-admin with core-reader and core-writer" });
  }
  return identity;
}

/** The backend application must be an enrolled core-writer of the configured tenant. */
export async function verifyBackendIdentity(config, junctura) {
  let backend;
  try {
    backend = await junctura.identity();
  } catch (error) {
    throw new PackLifecycleError(CODE.BACKEND_IDENTITY_REJECTED,
      { message: `the backend application token was not verified: ${error.message}`, ...(error instanceof JuncturaError && TRANSIENT.has(error.status) ? { uncertain: true } : {}) });
  }
  if (backend.tenantId !== config.tenant || !backend.roles?.includes("core-writer")) {
    throw new PackLifecycleError(CODE.BACKEND_IDENTITY_REJECTED,
      { message: "the backend application is not a core-writer of the configured tenant, so it must not own the pack records" });
  }
  return backend;
}

/**
 * The narrow Directory-permission preflight. Real Core requires every
 * Directory write by an enrolled management principal bound to the verified
 * subject, issuer and client (directory.write) — separate from the
 * console-admin role that BPMN publication needs (Core source
 * infra/postgres/037-directory-management.sql, docs/CORE_API.md). The type
 * list `GET /v1/directory/unit-types?limit=1` exercises exactly
 * directory.write with the same operator credential the install will use; it
 * is a read, so a failure here happens before any ws_packs, Directory or
 * Flowable mutation. The Console unit-list shortcut is deliberately not used.
 */
async function preflightDirectoryPermission(config) {
  const response = await operatorRequest(config, "/v1/directory/unit-types?limit=1");
  await response.body?.cancel().catch(() => {});
  if (response.ok) return;
  if (response.status === 403) {
    throw new PackLifecycleError(CODE.OPERATOR_IDENTITY_REJECTED,
      { message: `the verified console-admin operator is not enrolled as a Directory manager with directory.write (HTTP 403; Core binds that enrollment to the verified subject, issuer and client — see docs/CORE_API.md); enroll the operator, then rerun — nothing was changed` });
  }
  throw uncertain(`the Directory permission preflight could not be read: HTTP ${response.status}`);
}

function backendClient(config) {
  return createJuncturaClient({
    baseUrl: config.baseUrl,
    clientId: config.backend.clientId,
    clientSecret: config.backend.clientSecret,
  });
}

/** Operator bearer request (Directory reads/writes, BPMN publication). */
async function operatorRequest(config, path, { method = "GET", json, headers = {} } = {}) {
  try {
    return await fetch(new URL(path, config.baseUrl), {
      method,
      headers: {
        authorization: `Bearer ${config.operatorToken}`,
        ...(json !== undefined ? { "content-type": "application/json" } : {}),
        ...headers,
      },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw uncertain(`${method} ${path}: ${error.message}`);
  }
}

/**
 * Registers the ws_packs collection schema with the backend identity.
 * Registration is desired-state (replaying the identical PUT is safe); the
 * owner's index only exists after this, so it always precedes reading or
 * writing pack records.
 */
async function registerSchema(junctura, schema, { what }) {
  try {
    await junctura.request(`/v2/data-schemas/${WS_PACKS_COLLECTION}`, { method: "PUT", json: schema });
  } catch (error) {
    throw upstreamError(`registering ${what}`, error);
  }
}

/** The record shape every ws_packs record must have; anything else stops the run. */
function checkPackRecordShape(record) {
  const { packId, version } = record?.data ?? {};
  if (record?.collection !== WS_PACKS_COLLECTION || !record.data || typeof packId !== "string" ||
    typeof version !== "string" || typeof record.data.contentHash !== "string" ||
    record.data.key !== recordKeyFor(packId, version)) {
    throw new PackLifecycleError(CODE.RECORD_SCOPE_MISMATCH,
      { message: "a ws_packs record outside the expected app-owned pack scope was found; refusing to touch pack state" });
  }
  try {
    compareVersions(version, version);
  } catch {
    throw new PackLifecycleError(CODE.RECORD_SCOPE_MISMATCH,
      { message: `the recorded version "${version}" is not an orderable pack version; refusing to touch pack state` });
  }
}

/**
 * The ws_packs records of one pack id, read through the backend application
 * (the app-private owner scope) with cursor pagination until the end. The
 * schemas are registered before any read, so a 404 here is a real owner or
 * authorization problem, never a missing index.
 */
async function readPackRecords(junctura, packId) {
  const records = [];
  let cursor;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ limit: "100", "where[packId]": `eq:${JSON.stringify(packId)}` });
    if (cursor) query.set("cursor", cursor);
    let result;
    try {
      result = await (await junctura.request(`/v2/data/${WS_PACKS_COLLECTION}?${query}`)).json();
    } catch (error) {
      throw upstreamError(`reading ${WS_PACKS_COLLECTION}`, error);
    }
    for (const record of result?.items ?? []) {
      checkPackRecordShape(record);
      if (record.data.packId !== packId) {
        throw new PackLifecycleError(CODE.RECORD_SCOPE_MISMATCH,
          { message: "a ws_packs record outside the expected app-owned pack scope was found; refusing to touch pack state" });
      }
      records.push(record);
    }
    cursor = result?.nextCursor;
    if (!cursor) return records;
  }
  throw new PackLifecycleError(CODE.RECORD_SCOPE_MISMATCH,
    { message: `more than ${20 * 100} recorded versions of pack ${packId}; refusing to select beyond a bounded stable page set` });
}

/** Reads one record by id together with its strong owner ETag. */
async function readRecordEtagged(junctura, collection, recordId) {
  let response;
  try {
    response = await junctura.request(`/v2/data/${collection}/${recordId}`);
  } catch (error) {
    throw upstreamError(`reading record ${recordId}`, error);
  }
  const etag = response.headers.get("etag");
  if (!etag) throw new PackLifecycleError(CODE.UPSTREAM_REJECTED, { message: `record ${recordId} was returned without an ETag` });
  return { record: await response.json(), etag };
}

/** Creates or replaces a record by its unique key (by-key upsert, pinned semantics). */
async function upsertByKey(junctura, collection, key, data, { idempotencyKey, ifMatch } = {}) {
  try {
    const response = await junctura.request(`/v2/data/${collection}/by-key/${encodeURIComponent(key)}`, {
      method: "PUT", json: { data }, idempotencyKey, ...(ifMatch !== undefined ? { ifMatch } : {}),
    });
    return { status: response.status, body: await response.json(), etag: response.headers.get("etag") };
  } catch (error) {
    if (error instanceof JuncturaError) {
      if (classify(error.status) === "transient") throw uncertain(`${collection}/${key}: ${error.message}`);
      return { status: error.status, code: error.code };
    }
    throw uncertain(`${collection}/${key}: ${error.message}`);
  }
}

/**
 * Builds the executable plan of one real install from the offline dry-run plan
 * and the freshly read pack: the same ordered Directory PUT steps, plus ready
 * ws_packs schema-registration, reservation, BPMN publication and finalize
 * steps whose idempotency keys are derived deterministically from
 * `tenant|packId|version|op|contentHash` (version+content identity), so a rerun
 * in any process reuses exactly the same keys and bodies. The dry-run plan
 * itself is never mutated and its own output contract is unchanged.
 */
export function buildExecutablePlan({ plan, pack, tenant }) {
  if (!plan?.ok || plan?.plan?.mode !== "install" || !Array.isArray(plan?.plan?.steps)) {
    throw new PackLifecycleError(CODE.PLAN_INVALID, { message: "the dry-run plan could not be read; run the planner first" });
  }
  if (typeof tenant !== "string" || !tenant) {
    throw new PackLifecycleError(CODE.LIFECYCLE_CONFIG_MISSING, { message: "JUNCTURA_TENANT is required (see docs/PACK_FORMAT.md)" });
  }
  const dryRun = plan.plan;
  const packId = pack?.manifest?.id;
  const version = pack?.manifest?.version;
  if (dryRun.pack?.id !== packId || dryRun.pack?.version !== version || !packId || !version) {
    throw new PackLifecycleError(CODE.PLAN_INVALID,
      { message: `the plan describes pack ${dryRun.pack?.id} ${dryRun.pack?.version} but the pack read from disk is ${packId} ${version}` });
  }
  const contentHash = packContentHash(pack);
  const recordKey = recordKeyFor(packId, version);
  const directory = { unitTypes: [], units: [], groups: [] };
  const directorySteps = [];
  for (const step of dryRun.steps) {
    if (step?.status !== "ready") continue;
    if (step.kind === "directory.unitType.put") {
      directory.unitTypes.push(step.path.slice("/v1/directory/unit-types/".length));
      directorySteps.push(step);
    } else if (step.kind === "directory.unit.put") {
      directory.units.push(step.path.slice("/v1/directory/units/".length));
      directorySteps.push(step);
    } else if (step.kind === "directory.group.put") {
      const [unit = "", group = ""] = step.path.slice("/v1/directory/units/".length).split("/groups/");
      if (!unit || !group) {
        throw new PackLifecycleError(CODE.PLAN_INVALID, { message: `the group step path "${step.path}" does not carry both the unit and the group id` });
      }
      directory.groups.push({ unit, group });
      directorySteps.push(step);
    } else {
      throw new PackLifecycleError(CODE.PLAN_INVALID, { message: `unexpected ready step ${step.kind} in the dry-run plan` });
    }
  }
  const definitions = pack.workflows.map(workflow => ({ workflow: workflow.id, key: workflow.id }));
  const skeleton = { key: recordKey, packId, version, contentHash, definitions, directory };
  const steps = [
    { kind: "ws_packs.schema.register", status: "ready" },
    {
      kind: "ws_packs.reservation.create", status: "ready",
      idempotencyKey: operationKey(operationSeed(tenant, packId, version, "reserve", undefined, contentHash)),
      body: { data: { ...skeleton, status: "installing" } },
    },
    ...directorySteps,
    ...pack.workflows.map(workflow => ({
      kind: "bpmn.definition.publish", status: "ready",
      workflow: workflow.id, definitionKey: workflow.id,
      idempotencyKey: operationKey(operationSeed(tenant, packId, version, "publish", workflow.id, contentHash)),
      body: { xml: workflow.xml },
    })),
    {
      kind: "ws_packs.packRecord.finalize", status: "ready",
      idempotencyKey: operationKey(operationSeed(tenant, packId, version, "finalize", undefined, contentHash)),
      body: { data: { ...skeleton, status: "available" } },
    },
  ];
  return {
    ok: true,
    plan: {
      command: "pack:install",
      dryRun: false,
      mode: "install",
      pack: { ...dryRun.pack, contentHash },
      steps,
      notes: dryRun.notes,
    },
  };
}

/**
 * Real install of one validated pack, driven by the executable plan the
 * builder produced: verifies the operator and backend identities, registers
 * the ws_packs collection schema, compares the recorded pack state, durably
 * reserves the exact version/content by key, applies the Directory desired
 * state, publishes every BPMN workflow under its derived key and finally
 * finalizes the reservation to "available" with an If-Match-conditional
 * replace. The plan order is the execution order; a rerun after an uncertain
 * outcome reuses exactly the same request keys and bodies; the run never picks
 * a fresh key.
 */
export async function installPack({ plan, config, attempts = 4, delayMs = 250, log = () => {} }) {
  const junctura = backendClient(config);
  const packId = plan?.pack?.id;
  const version = plan?.pack?.version;
  const contentHash = plan?.pack?.contentHash;
  const steps = Array.isArray(plan?.steps) ? plan.steps.filter(step => step?.status === "ready") : [];
  const rank = kind => ({
    "ws_packs.schema.register": 0,
    "ws_packs.reservation.create": 2,
    "directory.unitType.put": 3,
    "directory.unit.put": 3,
    "directory.group.put": 3,
    "bpmn.definition.publish": 4,
    "ws_packs.packRecord.finalize": 5,
  })[kind];
  const ranks = steps.map(step => rank(step.kind));
  if (!packId || !version || !contentHash || ranks.includes(undefined) ||
    !steps.some(step => step.kind === "ws_packs.schema.register") ||
    !steps.some(step => step.kind === "ws_packs.reservation.create") ||
    !steps.some(step => step.kind === "ws_packs.packRecord.finalize") ||
    ranks.some((value, index) => index > 0 && value < ranks[index - 1])) {
    throw new PackLifecycleError(CODE.PLAN_INVALID,
      { message: "the install plan does not carry the pack identity, content hash and the ready steps in the pinned order (schema registration, reservation, Directory, BPMN publication, finalize)" });
  }
  const recordKey = recordKeyFor(packId, version);

  await verifyOperatorIdentity(config);
  await verifyBackendIdentity(config, junctura);
  await preflightDirectoryPermission(config);
  log("identities verified (direct tenant console-admin and enrolled backend)");
  log("the operator is enrolled as a Directory manager (directory.write preflight passed)");

  for (const step of steps) {
    if (step.kind === "ws_packs.schema.register") {
      await registerSchema(junctura, WS_PACKS_SCHEMA, { what: WS_PACKS_COLLECTION });
      log(`${WS_PACKS_COLLECTION} schema registered`);
    }
  }

  // State comparison before the reservation: the recorded pack state decides
  // replay, resume or refusal before any effect of this run.
  const existing = await readPackRecords(junctura, packId);
  const sameVersion = existing.find(record => record.data.version === version);
  let resume = false;
  if (sameVersion) {
    if (sameVersion.data.contentHash !== contentHash) {
      throw new PackLifecycleError(CODE.VERSION_CONTENT_MISMATCH,
        { message: `pack ${packId} ${version} is already reserved with different content (${sameVersion.data.contentHash} recorded, ${contentHash} on disk); never republish changed content under the same version` });
    }
    if (sameVersion.data.status === "installing") {
      resume = true;
      log(`resuming the incomplete reservation of ${packId} ${version} with the same request keys`);
    } else {
      log(`pack ${packId} ${version} is already installed (${sameVersion.data.status}); nothing to change`);
      return { outcome: "replayed", record: sameVersion.data };
    }
  } else {
    const newer = existing
      .filter(record => compareVersions(record.data.version, version) > 0)
      .map(record => record.data.version);
    if (newer.length) {
      throw new PackLifecycleError(CODE.VERSION_NOT_GREATER,
        { message: `a newer version of pack ${packId} is already installed (${newer.join(", ")} > ${version}); installing would overwrite or rewind the recorded pack state` });
    }
  }

  try {
    const publishedDefinitions = [];
    for (const step of steps) {
      if (step.kind === "ws_packs.reservation.create") {
        if (resume) continue;
        const reservationKey = requirePlanKey(step, packId, version);
        const outcome = await upsertByKey(junctura, WS_PACKS_COLLECTION, recordKey, step.body.data, { idempotencyKey: reservationKey });
        if (outcome.status === 201) {
          log(`reservation ${recordKey} created (HTTP 201) before any Directory or workflow effect`);
        } else if (outcome.status === 428 || outcome.status === 412) {
          // Another request created the reservation first: it wins the version
          // by durable uniqueness, and this run loses before any effect if the
          // content differs. The same content resumes the same install.
          const winner = (await readPackRecords(junctura, packId)).find(record => record.data.version === version);
          if (!winner || winner.data.contentHash !== contentHash) {
            throw new PackLifecycleError(CODE.VERSION_CONTENT_MISMATCH,
              { message: `pack ${packId} ${version} is reserved by a simultaneous install with different content; this run made no effect` });
          }
          if (winner.data.status !== "installing") {
            log(`pack ${packId} ${version} was completed by a concurrent install; nothing to change`);
            return { outcome: "replayed", record: winner.data };
          }
          log(`resuming the concurrent incomplete reservation of ${packId} ${version}`);
        } else if (outcome.status === 422) {
          throw new PackLifecycleError(CODE.RECORD_IDEMPOTENCY_CONFLICT,
            { message: "the reservation request key was reused with a different body; investigate before rerunning — never resolve it by picking a fresh key" });
        } else {
          throw new PackLifecycleError(CODE.RECORD_PRECONDITION,
            { message: `creating the reservation failed (HTTP ${outcome.status}${outcome.code ? ` ${outcome.code}` : ""})` });
        }
      } else if (step.kind === "directory.unitType.put" || step.kind === "directory.unit.put" || step.kind === "directory.group.put") {
        await applyDirectoryStep(config, step, { attempts, delayMs, log });
      } else if (step.kind === "bpmn.definition.publish") {
        const key = requirePlanKey(step, packId, version);
        if (typeof step.definitionKey !== "string" || !/^[a-z][a-z0-9_]{2,63}$/.test(step.definitionKey)) {
          throw new PackLifecycleError(CODE.PLAN_INVALID,
            { message: `the publish step for ${packId} ${version} does not carry a pinned definitionKey` });
        }
        const published = await retrying(attempt => {
          log(`publishing "${step.workflow}" (attempt ${attempt}, key ${key})`);
          return publishDefinition(config, step.definitionKey, key, step.body.xml);
        }, { attempts, delayMs });
        publishedDefinitions.push({
          workflow: step.workflow,
          key: step.definitionKey,
          definitionId: published.id,
          definitionVersion: published.version,
        });
        log(`definition "${step.workflow}" deployed as ${published.id} (version ${published.version})`);
      } else if (step.kind === "ws_packs.packRecord.finalize") {
        await finalizeRecord(junctura, plan, recordKey, publishedDefinitions, { log });
        log(`pack record ${recordKey} finalized to "available"`);
      }
    }
    return { outcome: "installed", record: finalRecordData(plan, publishedDefinitions) };
  } catch (error) {
    if (error?.uncertain === true) {
      throw new PackLifecycleError(CODE.PENDING_NOT_SETTLED, {
        message: `${error.message} — the outcome is uncertain; rerun the exact same command so the same request keys and bodies replay (never pick a fresh key automatically)`,
        uncertain: true,
        cause: error,
      });
    }
    throw error;
  }
}

/** The deterministic final record data: the planned skeleton plus the deployed definitions. */
function finalRecordData(plan, publishedDefinitions) {
  const skeleton = plan.steps.filter(step => step.status === "ready" && step.kind === "ws_packs.packRecord.finalize").at(-1).body.data;
  return {
    ...skeleton,
    status: "available",
    definitions: skeleton.definitions.map(entry => ({
      ...entry,
      ...publishedDefinitions.find(published => published.workflow === entry.workflow),
    })),
  };
}

/** Replaces the reservation by key under its current ETag, reconciling a concurrent finalize. */
async function finalizeRecord(junctura, plan, recordKey, publishedDefinitions, { log }) {
  const step = plan.steps.filter(item => item.status === "ready" && item.kind === "ws_packs.packRecord.finalize").at(-1);
  const key = requirePlanKey(step, plan.pack.id, plan.pack.version);
  const data = finalRecordData(plan, publishedDefinitions);
  const reservation = (await readPackRecords(junctura, plan.pack.id)).find(record => record.data.version === plan.pack.version);
  if (!reservation || reservation.data.contentHash !== plan.pack.contentHash || reservation.data.status !== "installing") {
    // The reservation must still be the incomplete one this run created or resumed.
    const record = reservation;
    if (record?.data.status === "available" && record.data.contentHash === plan.pack.contentHash) {
      log("a concurrent identical install already finalized this version; replaying its result");
      return;
    }
    throw new PackLifecycleError(CODE.RECORD_SCOPE_MISMATCH,
      { message: "the reservation is not the incomplete one this install created; refusing to finalize over foreign state" });
  }
  const { etag } = await readRecordEtagged(junctura, WS_PACKS_COLLECTION, reservation.id);
  const outcome = await upsertByKey(junctura, WS_PACKS_COLLECTION, recordKey, data, { idempotencyKey: key, ifMatch: etag });
  if (outcome.status === 200) return;
  if (outcome.status === 412) {
    // A concurrent identical-content install finalized first: same request
    // key, but the digest includes the If-Match, so reconcile by re-reading.
    const record = (await readPackRecords(junctura, plan.pack.id)).find(item => item.data.version === plan.pack.version);
    if (record?.data.status === "available" && record.data.contentHash === plan.pack.contentHash) {
      log("a concurrent identical install already finalized this version; replaying its result");
      return;
    }
    throw new PackLifecycleError(CODE.RECORD_PRECONDITION,
      { message: "the reservation changed underneath the finalize; rerun the same command to reconcile" });
  }
  if (outcome.status === 422) {
    throw new PackLifecycleError(CODE.RECORD_IDEMPOTENCY_CONFLICT,
      { message: "the finalize request key was reused with a different body; investigate before rerunning — never resolve it by picking a fresh key" });
  }
  throw new PackLifecycleError(CODE.RECORD_PRECONDITION,
    { message: `finalizing the pack record failed (HTTP ${outcome.status}${outcome.code ? ` ${outcome.code}` : ""})` });
}

/** The plan must carry the derived request key; a seed-only plan cannot execute. */
function requirePlanKey(step, packId, version) {
  if (typeof step?.idempotencyKey !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(step.idempotencyKey)) {
    throw new PackLifecycleError(CODE.PLAN_INVALID,
      { message: `the ${step?.kind ?? "plan"} step for ${packId} ${version} has no derived idempotency key; the executable plan builder must derive it from the tenant, version and content` });
  }
  return step.idempotencyKey;
}

/**
 * Reads one unit's current Directory state through the pinned units LIST
 * route (GET /v1/directory/units, cursor pagination). Core pins no GET on the
 * exact unit route (PUT is the only method there), so the unit is looked up
 * by its exact id across the paged listing; a page bound keeps the scan
 * stable, and exhausting it stops the run instead of risking a silent
 * overwrite of an unowned unit.
 */
async function readExistingUnit(config, unitId, log = () => {}) {
  let cursor;
  for (let page = 0; page < 50; page++) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const response = await operatorRequest(config, `/v1/directory/units?${query}`);
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw uncertain(`reading /v1/directory/units: HTTP ${response.status}`);
    }
    const listing = await response.json().catch(() => null);
    for (const unit of listing?.items ?? []) {
      if (unit?.id === unitId) return unit;
    }
    cursor = listing?.nextCursor;
    if (!cursor) return null;
  }
  log(`more than 5000 Directory units scanned without reaching unit ${unitId}`);
  throw uncertain(`the Directory unit listing for ${unitId} did not end within the bounded page set`);
}

/**
 * Applies one planned Directory desired-state step. The unit key is checked
 * against the Directory listing first: an existing unit of a different unit
 * type is unowned by this pack and is never repurposed; unit-type and
 * role-group names are desired-state labels at pack-owned stable keys and are
 * set to the planned value.
 */
async function applyDirectoryStep(config, step, { attempts, delayMs, log }) {
  const path = step.path;
  if (step.kind === "directory.unit.put") {
    const unitId = path.slice("/v1/directory/units/".length);
    const existing = await readExistingUnit(config, unitId, log);
    if (existing && existing.unitType !== step.body.unitType) {
      throw new PackLifecycleError(CODE.DIRECTORY_SCOPE_MISMATCH,
        { message: `the Directory unit ${unitId} already exists with unit type "${existing.unitType}", not "${step.body.unitType}"; the pack never repurposes an unowned unit key` });
    }
  }
  const outcome = await retrying(async () => {
    const response = await operatorRequest(config, path, { method: "PUT", json: step.body });
    if (response.status === 200 || response.status === 201) {
      await response.body?.cancel().catch(() => {});
      return response.status;
    }
    await response.body?.cancel().catch(() => {});
    if (classify(response.status) === "transient") throw uncertain(`directory ${path}: HTTP ${response.status}`);
    throw new PackLifecycleError(CODE.UPSTREAM_REJECTED, { message: `directory ${path}: HTTP ${response.status}` });
  }, { attempts, delayMs });
  log(`directory ${path}: HTTP ${outcome}`);
}

/**
 * One BPMN publication against the pinned contract, with pending-conflict
 * retries. The success reply must carry a nonempty string id, the EXACT
 * requested definition key and a positive integer version; anything else is
 * an uncertain outcome — the reservation stays incomplete and the run stops
 * instead of finalizing over an unknown deployment.
 */
async function publishDefinition(config, definitionKey, idempotencyKey, xml) {
  const response = await operatorRequest(config, "/v1/workflows/definitions", {
    method: "POST",
    json: { xml },
    headers: { "idempotency-key": idempotencyKey },
  });
  const body = await response.json().catch(() => null);
  if (response.status === 200 || response.status === 201) {
    if (typeof body?.id !== "string" || !body.id || body.key !== definitionKey ||
      !Number.isInteger(body.version) || body.version < 1) {
      throw uncertain(`publishing definition: the gateway answered ${response.status} with key "${body?.key ?? "none"}" instead of the requested definition key "${definitionKey}" and a usable {id, key, version}`);
    }
    return body;
  }
  if (response.status === 409 && body?.error === "idempotency_conflict") {
    throw new PackLifecycleError(CODE.DEFINITION_CONFLICT, {
      message: "409 idempotency_conflict: the derived operation key is reserved with different content; never retry under a fresh key and never republish changed content under the same version — resolve the conflict, then rerun the same command",
    });
  }
  if (response.status === 409 && body?.error === "deployment_pending_reconciliation") {
    throw uncertain("409 deployment_pending_reconciliation: another request reserved the derived key; retry the same key after reconciliation — never pick a fresh key automatically");
  }
  if (response.status === 400 && body?.error === "definition_invalid") {
    throw new PackLifecycleError(CODE.DEFINITION_POLICY_INVALID, {
      message: "the gateway rejected the definition (Core stays authoritative about business BPMN); the reservation stays incomplete and safe — fix the pack, then rerun",
      problems: body.problems,
    });
  }
  if (classify(response.status) === "transient") {
    throw uncertain(`publishing definition: HTTP ${response.status}${body?.error ? ` ${body.error}` : ""}`);
  }
  throw new PackLifecycleError(CODE.UPSTREAM_REJECTED,
    { message: `publishing definition: HTTP ${response.status}${body?.error ? ` ${body.error}` : ""}` });
}

/**
 * Admin-readable inspection of the recorded pack state: every ws_packs record
 * of the app-owned collection, read through the backend application with
 * cursor pagination until the end. This is a read-only command — it mutates
 * nothing and never registers the schema. A 404 means the collection does not
 * exist yet (a fresh stack): an empty list, not an error. Any other failure
 * (authorization, transient upstream) is reported instead of being silently
 * read as "nothing installed".
 */
export async function listInstalledPacks({ config, log = () => {} }) {
  const junctura = backendClient(config);
  await verifyBackendIdentity(config, junctura);
  const records = [];
  let cursor;
  let pages = 0;
  while (true) {
    const query = new URLSearchParams({ limit: "100" });
    if (cursor) query.set("cursor", cursor);
    let result;
    try {
      result = await (await junctura.request(`/v2/data/${WS_PACKS_COLLECTION}?${query}`)).json();
    } catch (error) {
      if (error instanceof JuncturaError && error.status === 404 && pages === 0) {
        log(`${WS_PACKS_COLLECTION} does not exist yet (fresh owner scope); nothing is installed`);
        return { outcome: "listed", collection: "absent", packs: [] };
      }
      if (error instanceof JuncturaError && classify(error.status) === "transient") {
        throw uncertain(`reading ${WS_PACKS_COLLECTION}: ${error.message}`);
      }
      throw new PackLifecycleError(CODE.UPSTREAM_REJECTED,
        { message: `reading ${WS_PACKS_COLLECTION}: ${error instanceof Error ? error.message : String(error)}`, cause: error });
    }
    for (const record of result?.items ?? []) checkPackRecordShape(record);
    records.push(...(result?.items ?? []).map(record => record.data));
    cursor = result?.nextCursor;
    pages++;
    if (!cursor) break;
    if (pages >= 20) {
      throw new PackLifecycleError(CODE.RECORD_SCOPE_MISMATCH,
        { message: `more than ${20 * 100} recorded pack versions; refusing to list beyond a bounded stable page set` });
    }
  }
  try {
    records.sort((a, b) => (a.packId < b.packId ? -1 : a.packId > b.packId ? 1 : compareVersions(b.version, a.version)));
  } catch {
    throw new PackLifecycleError(CODE.RECORD_SCOPE_MISMATCH,
      { message: "a recorded pack version cannot be ordered; refusing to report pack state" });
  }
  return {
    outcome: "listed",
    collection: records.length ? "populated" : "empty",
    packs: records.map(data => ({
      packId: data.packId,
      version: data.version,
      status: data.status,
      contentHash: data.contentHash,
      complete: data.status === "available",
      definitions: data.definitions ?? [],
      directory: data.directory ?? null,
    })),
  };
}
