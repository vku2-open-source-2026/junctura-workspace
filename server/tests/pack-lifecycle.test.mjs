// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Contract tests of the real pack install and inspection (issue #12 install
// slice, server/pack-lifecycle.mjs). Everything runs against a mock DX-OS Core
// on the HTTP loopback — the exact pinned SDK (@junctura/server-client) dials
// it like the real Gateway, so the pinned wire contract is exercised for real:
// client-credentials token issuance, GET /v1/identity per bearer, desired-state
// data-schema registration, by-key upsert with If-Match/412/428/422 semantics,
// cursor pagination, and the DX-OS #113 definition deployment (201 new, 200
// identical replay, 409 idempotency_conflict, 409
// deployment_pending_reconciliation, 503 workflow_unavailable). The real merged
// Education pack is installed from throwaway fixture copies; no credentials,
// no shared infrastructure. Explicit selection/activation/retirement is
// deliberately absent from this slice and is not tested here.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  PackLifecycleErrorCode,
  WS_PACKS_COLLECTION,
  WS_PACKS_SCHEMA,
  buildExecutablePlan,
  compareVersions,
  installPack,
  listInstalledPacks,
  packContentHash,
  recordKeyFor,
} from "../pack-lifecycle.mjs";
import { readPack } from "../packs.mjs";
import { planPackInstall } from "../../scripts/pack-install.mjs";

const CODE = PackLifecycleErrorCode;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "scripts", "pack-install.mjs");
const EDUCATION = path.join(ROOT, "examples", "packs", "education");

const TENANT = "tenant-so-1";
const CLIENT_ID = "ws-pack-backend";
const CLIENT_SECRET = "ws-pack-backend-secret";
const OPERATOR_TOKEN = "operator-console-admin-token";

/**
 * A stateful mock of the pinned DX-OS Core contract on the HTTP loopback.
 * Faults are configurable between runs so a rerun after an uncertain outcome
 * can be exercised against the same live state, exactly like the real stack.
 */
async function startMockCore({
  tenant = TENANT,
  operatorToken = OPERATOR_TOKEN,
  operatorIdentity = { subject: "ops-admin", tenantId: tenant, consoleRole: "admin", roles: ["core-writer", "core-reader"] },
  appIdentity = { subject: "pack-backend", tenantId: tenant, roles: ["core-writer", "core-reader"] },
} = {}) {
  const state = {
    schemas: new Map(),
    records: new Map(),
    idempotency: new Map(),
    deployments: new Map(),
    appTokens: new Map(),
    appCounter: 0,
    faults: { directoryFail: false, publishPending: 0, publishUnavailable: 0, publishBadReply: false, raceFinalize: false, dataForbidden: false, operatorDirectoryWrite: false },
  };
  const requests = [];
  const recordsOf = collection => {
    if (!state.records.has(collection)) state.records.set(collection, new Map());
    return state.records.get(collection);
  };
  const recordBody = (collection, record) => ({ id: record.id, collection, data: record.data });
  const digestOf = (ifMatch, data) => JSON.stringify({ ifMatch: ifMatch ?? null, data });
  const unauthorized = response => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not_authenticated" }));
  };
  const bearerOf = request => /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? null;

  /** A compact Core-side record validator: strings/arrays/nested objects, patterns, enums. */
  const validateRecordData = (schemaPart, value, at) => {
    const problems = [];
    if (schemaPart.type === "object" && value !== null && typeof value === "object" && !Array.isArray(value)) {
      for (const field of schemaPart.required ?? []) {
        if (!(field in value)) problems.push(`${at}/${field} required`);
      }
      for (const [field, sub] of Object.entries(schemaPart.properties ?? {})) {
        if (field in value) problems.push(...validateRecordData(sub, value[field], `${at}/${field}`));
      }
    } else if (schemaPart.type === "array" && Array.isArray(value)) {
      value.forEach((item, index) => problems.push(...validateRecordData(schemaPart.items, item, `${at}/${index}`)));
    } else if (schemaPart.type === "string") {
      if (typeof value !== "string") problems.push(`${at} not a string`);
      else if (schemaPart.pattern && !new RegExp(schemaPart.pattern).test(value)) problems.push(`${at} violates ${schemaPart.pattern}`);
    }
    return problems;
  };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(request.url, "http://loopback");
      const path = url.pathname;
      const query = url.searchParams;
      const bearer = bearerOf(request);
      let parsedBody = null;
      try {
        parsedBody = body ? JSON.parse(body) : null;
      } catch {
        parsedBody = body;
      }
      requests.push({
        method: request.method,
        path,
        idempotencyKey: request.headers["idempotency-key"] ?? null,
        ifMatch: request.headers["if-match"] ?? null,
        body: parsedBody,
      });

      const json = (status, payload, headers = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(payload));
      };
      const appBearer = bearer !== null && state.appTokens.has(bearer);
      const appIdentityOf = appBearer ? state.appTokens.get(bearer) : null;
      const appScope = /^\/v2\//.test(path);
      const operatorScope = /^\/v1\/(directory|workflows)\//.test(path);

      if (request.method === "POST" && path === "/identity/realms/junctura/protocol/openid-connect/token") {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") !== "client_credentials" || form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
          return json(401, { error: "authentication_failed" });
        }
        const token = `app-token-${++state.appCounter}`;
        state.appTokens.set(token, appIdentity);
        return json(200, { access_token: token, token_type: "Bearer", expires_in: 300 });
      }

      if (request.method === "GET" && path === "/v1/identity") {
        if (bearer === operatorToken) return json(200, operatorIdentity);
        if (appIdentityOf) return json(200, appIdentityOf);
        return unauthorized(response);
      }

      if (appScope && !appIdentityOf) return unauthorized(response);
      if (operatorScope && bearer !== operatorToken) return unauthorized(response);

      if (request.method === "PUT" && /^\/v2\/data-schemas\/[^/]+$/.test(path)) {
        const collection = path.slice("/v2/data-schemas/".length);
        const schema = JSON.parse(body);
        if (state.schemas.has(collection)) {
          return json(JSON.stringify(state.schemas.get(collection)) === JSON.stringify(schema) ? 200 : 409, { collection });
        }
        state.schemas.set(collection, schema);
        return json(201, { collection });
      }

      if (state.faults.dataForbidden && request.method === "GET" && /^\/v2\/data\//.test(path)) {
        return json(403, { error: "not_authorized" });
      }

      const dataMatch = /^\/v2\/data\/([^/]+)(\/by-key\/[^/]+|\/[^/]+)?$/.exec(path);
      if (dataMatch) {
        const collection = decodeURIComponent(dataMatch[1]);
        const rest = dataMatch[2] ?? "";

        if (request.method === "GET" && rest === "") {
          if (!state.schemas.has(collection)) return json(404, { error: "collection_not_found" });
          let items = [...recordsOf(collection).values()];
          for (const [key, value] of query) {
            const where = /^where\[(.+)\]$/.exec(key);
            if (!where) continue;
            const [op, literal] = [value.slice(0, 3), value.slice(3)];
            if (op !== "eq:") return json(400, { error: "unsupported_filter" });
            const expected = JSON.parse(literal);
            items = items.filter(item => item.data[where[1]] === expected);
          }
          const limit = Number(query.get("limit") ?? 100);
          const offset = Number(query.get("cursor") ?? 0);
          const page = items.slice(offset, offset + limit);
          const payload = { items: page.map(item => recordBody(collection, item)) };
          if (offset + limit < items.length) payload.nextCursor = String(offset + limit);
          return json(200, payload);
        }

        if (request.method === "GET" && rest !== "" && !rest.startsWith("/by-key/")) {
          const id = decodeURIComponent(rest.slice(1));
          for (const item of recordsOf(collection).values()) {
            if (item.id === id) return json(200, recordBody(collection, item), { etag: `"r${item.etag}"` });
          }
          return json(404, { error: "record_not_found" });
        }

        if (request.method === "PUT" && rest.startsWith("/by-key/")) {
          const key = decodeURIComponent(rest.slice("/by-key/".length));
          const idempotencyKey = request.headers["idempotency-key"];
          if (!idempotencyKey) return json(400, { error: "idempotency_key_required" });
          const { data } = JSON.parse(body);
          const digest = digestOf(request.headers["if-match"], data);
          const seen = state.idempotency.get(`${collection} ${key} ${idempotencyKey}`);
          if (seen) {
            if (seen.digest !== digest) return json(422, { error: "idempotency_conflict" });
            return json(seen.status, seen.body, seen.etag ? { etag: `"r${seen.etag}"` } : {});
          }
          const existing = recordsOf(collection).get(key);
          const ifMatch = request.headers["if-match"] ?? null;
          if (existing) {
            if (ifMatch === null) return json(428, { error: "precondition_required" });
            if (ifMatch !== `"r${existing.etag}"`) return json(412, { error: "precondition_failed" });
          } else if (ifMatch !== null) {
            return json(412, { error: "precondition_failed" });
          }
          // Core validates every record write against the registered schema.
          const schema = state.schemas.get(collection);
          if (schema) {
            const problems = validateRecordData(schema.schema, data, "/data");
            if (problems.length) return json(422, { error: "record_invalid", problems });
          }
          // A concurrent writer sneaks in between the owner read and this
          // conditional replace: the ETag the caller held is already stale.
          if (state.faults.raceFinalize && data.status === "available" && existing && ifMatch === `"r${existing.etag}"`) {
            state.faults.raceFinalize = false;
            existing.data = { ...existing.data, lastTouch: "a concurrent writer changed the reservation" };
            existing.etag++;
            return json(412, { error: "precondition_failed" });
          }
          const upserted = existing ?? { id: `${collection}-${key}`, data: null, etag: 0 };
          upserted.data = data;
          upserted.etag++;
          recordsOf(collection).set(key, upserted);
          const status = existing ? 200 : 201;
          const responseBody = recordBody(collection, upserted);
          state.idempotency.set(`${collection} ${key} ${idempotencyKey}`, { digest, status, body: responseBody, etag: upserted.etag });
          return json(status, responseBody, { etag: `"r${upserted.etag}"` });
        }
      }

      // Core pins PUT as the only method on the exact unit route: a read must
      // go through the units LIST contract, never a per-unit GET.
      if (request.method === "GET" && /^\/v1\/directory\/units\/[^/]+$/.test(path)) {
        return json(405, { error: "method_not_allowed" });
      }

      if (request.method === "GET" && path === "/v1/directory/units") {
        const items = [...recordsOf("directory-units").entries()]
          .map(([id, unit]) => ({ id, unitType: unit.unitType, name: unit.name }));
        const limit = Number(query.get("limit") ?? 100);
        const offset = Number(query.get("cursor") ?? 0);
        const page = items.slice(offset, offset + limit);
        const payload = { items: page };
        if (offset + limit < items.length) payload.nextCursor = String(offset + limit);
        return json(200, payload);
      }

      // The unit-type list exercises directory.write: without that enrolled
      // Directory-manager permission Core answers 403 here, before any
      // Directory write could succeed.
      if (request.method === "GET" && path === "/v1/directory/unit-types") {
        if (state.faults.operatorDirectoryWrite) return json(403, { error: "not_authorized" });
        const items = [...recordsOf("directory-unit-types").entries()]
          .map(([id, unitType]) => ({ id, name: unitType.name }));
        const limit = Number(query.get("limit") ?? 100);
        const offset = Number(query.get("cursor") ?? 0);
        const page = items.slice(offset, offset + limit);
        const payload = { items: page };
        if (offset + limit < items.length) payload.nextCursor = String(offset + limit);
        return json(200, payload);
      }

      if (request.method === "PUT" && /^\/v1\/directory\//.test(path)) {
        if (state.faults.directoryFail) return json(503, { error: "directory_unavailable" });
        const store = (map, id, value) => {
          const created = !map.has(id);
          map.set(id, value);
          return created ? 201 : 200;
        };
        let status;
        if (/^\/v1\/directory\/unit-types\//.test(path)) {
          status = store(recordsOf("directory-unit-types"), decodeURIComponent(path.slice("/v1/directory/unit-types/".length)), JSON.parse(body));
        } else if (/^\/v1\/directory\/units\/[^/]+\/groups\//.test(path)) {
          const [unit, group] = path.slice("/v1/directory/units/".length).split("/groups/");
          status = store(recordsOf("directory-groups"), `${unit} ${group}`, { unit, group, ...JSON.parse(body) });
        } else if (/^\/v1\/directory\/units\//.test(path)) {
          status = store(recordsOf("directory-units"), decodeURIComponent(path.slice("/v1/directory/units/".length)), JSON.parse(body));
        } else {
          return json(404, { error: "not_found" });
        }
        return json(status, { ok: true });
      }

      if (request.method === "POST" && path === "/v1/workflows/definitions") {
        const idempotencyKey = request.headers["idempotency-key"];
        if (!idempotencyKey) return json(400, { error: "idempotency_key_required" });
        const { xml } = JSON.parse(body);
        if (state.faults.publishPending > 0) {
          state.faults.publishPending--;
          return json(409, { error: "deployment_pending_reconciliation" });
        }
        if (state.faults.publishUnavailable > 0) {
          state.faults.publishUnavailable--;
          return json(503, { error: "workflow_unavailable" });
        }
        const deployed = state.deployments.get(idempotencyKey);
        if (deployed) {
          return deployed.xml === xml
            ? json(200, deployed.result)
            : json(409, { error: "idempotency_conflict" });
        }
        if (state.faults.publishBadReply > 0) {
          state.faults.publishBadReply--;
          return json(201, { id: "", key: "khac-phan-hoi", version: 0 });
        }
        const processId = /<process[^>]*\bid="([^"]+)"/.exec(xml)?.[1];
        const result = { id: `def-${state.deployments.size + 1}`, key: processId, version: 1 };
        state.deployments.set(idempotencyKey, { xml, result });
        return json(201, result);
      }

      return json(404, { error: "not_found" });
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests,
    state,
    close: async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

const lifecycleConfig = (mock, overrides = {}) => ({
  baseUrl: mock.url,
  tenant: TENANT,
  backend: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
  operatorToken: OPERATOR_TOKEN,
  ...overrides,
});

/** Reads and plans a pack offline, then builds the executable plan for one tenant. */
async function executablePlanFor(packDir, tenant = TENANT) {
  const [planned, read] = await Promise.all([planPackInstall(packDir), readPack(packDir)]);
  assert.ok(planned.ok && read.ok, `the fixture pack must plan and read cleanly: ${JSON.stringify(planned.errors ?? read.errors)}`);
  return buildExecutablePlan({ plan: planned, pack: read.pack, tenant }).plan;
}

/** Copies the education fixture into a throwaway dir, optionally mutated. */
async function withPackCopy(mutate = async () => {}) {
  const base = await mkdtemp(path.join(tmpdir(), "junctura-lifecycle-"));
  const pack = path.join(base, "pack");
  await cp(EDUCATION, pack, { recursive: true });
  await mutate(pack);
  try {
    return { pack, cleanup: () => rm(base, { recursive: true, force: true }) };
  } catch (error) {
    await rm(base, { recursive: true, force: true });
    throw error;
  }
}

test("compareVersions orders semver-safe pack versions and recordKeyFor keeps versions distinct", () => {
  assert.equal(compareVersions("0.2.0", "0.2.0"), 0);
  assert.equal(compareVersions("1.2.3", "1.20.0"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0"), -1);
  assert.equal(compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), -1);
  assert.equal(compareVersions("1.0.0-rc", "1.0.0-rc.1"), -1);
  assert.equal(compareVersions("1.0.0-alpha", "1.0.0-beta"), -1);
  assert.equal(recordKeyFor("education", "0.2.0"), "education-0_2_0");
  assert.notEqual(recordKeyFor("education", "1.2.3-rc.1"), recordKeyFor("education", "1.2.3-rc-1"));
  assert.equal(recordKeyFor("education", `${"9".repeat(200)}`), recordKeyFor("education", `${"9".repeat(200)}`));
  assert.notEqual(recordKeyFor("education", `${"9".repeat(200)}`), recordKeyFor("education", `${"8".repeat(200)}`));
  assert.throws(() => compareVersions("1.2", "1.2.0"), TypeError);
});

test("the ws_packs schema uses only the pinned Core regex subset and registers on a blank owner scope", async t => {
  // No grouping, no alternation, no escapes: an unescaped hyphen always sits
  // last in its character class, exactly what Core's PostgreSQL-safe subset
  // accepts on a blank owner scope.
  const patterns = [];
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value !== null && typeof value === "object") {
      if (typeof value.pattern === "string") patterns.push(value.pattern);
      Object.values(value).forEach(walk);
    }
  };
  walk(WS_PACKS_SCHEMA);
  assert.ok(patterns.length > 0);
  for (const pattern of patterns) {
    assert.doesNotMatch(pattern, /[()|\\]/, `${pattern} leaves the pinned subset`);
    assert.doesNotThrow(() => new RegExp(pattern));
  }
  assert.equal(WS_PACKS_SCHEMA.schema.properties.version.pattern, "^[0-9A-Za-z.-]+$",
    "the version field re-declares no length bound (the manifest schema bounds versions by pattern alone) and keeps the unescaped hyphen last");

  const mock = await startMockCore();
  t.after(() => mock.close());
  const { pack, cleanup } = await withPackCopy();
  const plan = await executablePlanFor(pack);
  const outcome = await installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  await cleanup();
  assert.equal(outcome.outcome, "installed");
  const registration = mock.requests.find(request => request.method === "PUT" && request.path === "/v2/data-schemas/ws_packs");
  assert.ok(registration, "the schema must be registered before any pack read or write");
  assert.deepEqual(registration.body, WS_PACKS_SCHEMA);
  const firstDataRead = mock.requests.findIndex(request => request.path.startsWith(`/v2/data/${WS_PACKS_COLLECTION}`));
  const schemaIndex = mock.requests.indexOf(registration);
  assert.ok(schemaIndex !== -1 && firstDataRead > schemaIndex, "the owner index only exists after registration");
});

test("a real install reserves version and content before any effect and finalizes under the record ETag", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const { pack, cleanup } = await withPackCopy();
  const read = await readPack(pack);
  const plan = await executablePlanFor(pack);
  const outcome = await installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  await cleanup();

  assert.equal(outcome.outcome, "installed");
  assert.equal(outcome.record.status, "available");
  assert.equal(outcome.record.contentHash, packContentHash(read.pack));
  assert.equal(mock.state.deployments.size, read.pack.workflows.length);

  const schema = mock.requests.findIndex(request => request.method === "PUT" && request.path === "/v2/data-schemas/ws_packs");
  const preflight = mock.requests.findIndex(request => request.method === "GET" && request.path === "/v1/directory/unit-types");
  assert.ok(preflight !== -1 && preflight < schema,
    "the directory.write preflight must run on the operator credential before any mutation");
  const reservation = mock.requests.findIndex(request => request.method === "PUT" && request.path.startsWith(`/v2/data/${WS_PACKS_COLLECTION}/by-key/`));
  const firstDirectory = mock.requests.findIndex(request => request.method === "PUT" && request.path.startsWith("/v1/directory/"));
  const firstPublish = mock.requests.findIndex(request => request.path === "/v1/workflows/definitions");
  assert.ok(schema < reservation && reservation < firstDirectory && firstDirectory < firstPublish,
    "reservation must precede every Directory and Flowable effect");
  assert.equal(mock.requests[reservation].body.data.status, "installing");
  assert.equal(mock.requests[reservation].body.data.contentHash, packContentHash(read.pack));
  assert.match(mock.requests[reservation].idempotencyKey, /^[0-9a-f-]{36}$/);

  // The durable reservation receipts the exact ids the plan will address.
  const expectedDirectory = { unitTypes: [], units: [], groups: [] };
  for (const step of plan.steps) {
    if (step.kind === "directory.unitType.put") expectedDirectory.unitTypes.push(step.path.slice("/v1/directory/unit-types/".length));
    else if (step.kind === "directory.unit.put") expectedDirectory.units.push(step.path.slice("/v1/directory/units/".length));
    else if (step.kind === "directory.group.put") {
      const [unit, group] = step.path.slice("/v1/directory/units/".length).split("/groups/");
      expectedDirectory.groups.push({ unit, group });
    }
  }
  assert.deepEqual(mock.requests[reservation].body.data.directory, expectedDirectory);
  assert.ok(expectedDirectory.groups.length > 0 && expectedDirectory.groups.every(entry => entry.unit && entry.group),
    "the regression must cover the exact [unit, group] receipt, not a shifted ledger");

  // Reads go through the pinned units LIST route; the per-unit route only pins PUT.
  assert.ok(!mock.requests.some(request => request.method === "GET" && /^\/v1\/directory\/units\/[^/]+$/.test(request.path)),
    "Core pins no GET on the exact unit route (405); the installer must use the list contract");

  const finalize = mock.requests.findLast(request => request.method === "PUT" && request.path.startsWith(`/v2/data/${WS_PACKS_COLLECTION}/by-key/`));
  assert.equal(finalize.body.data.status, "available");
  const recordId = [...mock.state.records.get(WS_PACKS_COLLECTION).values()][0].id;
  const recordRead = mock.requests.find(request => request.method === "GET" && request.path === `/v2/data/${WS_PACKS_COLLECTION}/${recordId}`);
  assert.ok(recordRead, "finalize must read the reservation by id first");
  assert.equal(finalize.ifMatch, `"r1"`, "the finalize replace must carry the exact ETag the owner served");
});

test("running the same install twice replays without new effects", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const { pack, cleanup } = await withPackCopy();
  const plan = await executablePlanFor(pack);
  const first = await installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(first.outcome, "installed");
  const before = mock.requests.length;
  const deployments = mock.state.deployments.size;
  const second = await installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  await cleanup();
  assert.equal(second.outcome, "replayed");
  assert.deepEqual(second.record, first.record);
  const again = mock.requests.slice(before);
  assert.ok(again.every(request => !request.path.startsWith("/v1/directory/") || request.method === "GET") &&
    again.every(request => request.path !== "/v1/workflows/definitions" &&
    !request.path.startsWith(`/v2/data/${WS_PACKS_COLLECTION}/by-key/`)),
    "a replayed install must not write Directory, engine or record state again (the read-only preflight aside)");
  assert.equal(mock.state.deployments.size, deployments);
});

test("an uncertain Directory result keeps the reservation incomplete; the rerun completes with the same keys", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const { pack, cleanup } = await withPackCopy();
  const plan = await executablePlanFor(pack);

  mock.state.faults.directoryFail = true;
  await assert.rejects(
    installPack({ plan, config: lifecycleConfig(mock), attempts: 2, delayMs: 1 }),
    error => error.code === CODE.PENDING_NOT_SETTLED && error.uncertain === true,
  );
  const records = [...mock.state.records.get(WS_PACKS_COLLECTION).values()];
  assert.equal(records.length, 1);
  assert.equal(records[0].data.status, "installing");
  assert.equal(mock.state.deployments.size, 0, "an incomplete install must not have published anything");
  const firstKeys = mock.requests.filter(request => request.idempotencyKey).map(request => [request.path, request.idempotencyKey]);
  const reservationKey = firstKeys.find(([path]) => path.startsWith(`/v2/data/${WS_PACKS_COLLECTION}/by-key/`))?.[1];
  assert.equal(reservationKey, plan.steps.find(step => step.kind === "ws_packs.reservation.create").idempotencyKey,
    "the reservation key must be the deterministic version+content key of the plan");

  mock.state.faults.directoryFail = false;
  const outcome = await installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  await cleanup();
  assert.equal(outcome.outcome, "installed");
  assert.equal(mock.state.deployments.size, 2, "each workflow must be deployed exactly once across both runs");
  const secondKeys = mock.requests.filter(request => request.idempotencyKey).map(request => [request.path, request.idempotencyKey]);
  for (const publish of plan.steps.filter(step => step.kind === "bpmn.definition.publish")) {
    assert.ok(secondKeys.some(([, key]) => key === publish.idempotencyKey),
      `the rerun must republish "${publish.workflow}" under the same key, never a fresh one`);
  }
});

test("Core pending and an ambiguous engine outcome are retried under the same key without a second deployment", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const { pack, cleanup } = await withPackCopy();
  const plan = await executablePlanFor(pack);
  mock.state.faults.publishPending = 1;
  mock.state.faults.publishUnavailable = 1;
  const outcome = await installPack({ plan, config: lifecycleConfig(mock), attempts: 4, delayMs: 1 });
  await cleanup();
  assert.equal(outcome.outcome, "installed");
  assert.equal(mock.state.deployments.size, 2);
  const publishes = mock.requests.filter(request => request.path === "/v1/workflows/definitions");
  assert.equal(publishes.length, 4, "two workflows, each published once extra for the pending and the ambiguous attempt");
  const byWorkflow = new Map();
  for (const request of publishes) {
    const seen = byWorkflow.get(request.body.xml) ?? new Set();
    seen.add(request.idempotencyKey);
    byWorkflow.set(request.body.xml, seen);
  }
  for (const keys of byWorkflow.values()) assert.equal(keys.size, 1, "the same workflow must never be published under a fresh key");
});

test("conflicting same-version content is refused before any effect, even with no completion record", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const first = await withPackCopy();
  const plan = await executablePlanFor(first.pack);
  mock.state.faults.directoryFail = true;
  await assert.rejects(
    installPack({ plan, config: lifecycleConfig(mock), attempts: 2, delayMs: 1 }),
    error => error.code === CODE.PENDING_NOT_SETTLED,
  );
  const checkpoint = mock.requests.length;
  const published = mock.state.deployments.size;

  const second = await withPackCopy(async pack => {
    const manifest = JSON.parse(await readFile(manifestPath(pack), "utf8"));
    manifest.name = "Gói Giáo dục (khác nội dung)";
    await writeFile(manifestPath(pack), JSON.stringify(manifest, null, 2));
  });
  const conflicting = await executablePlanFor(second.pack);
  await assert.rejects(
    installPack({ plan: conflicting, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.VERSION_CONTENT_MISMATCH,
  );
  await first.cleanup();
  await second.cleanup();
  assert.deepEqual(mock.requests.slice(checkpoint).filter(request =>
    (request.method === "PUT" || request.method === "POST") &&
    !request.path.endsWith("/openid-connect/token") &&
    request.path !== "/v2/data-schemas/ws_packs"),
    [], "the refused run must not have written any record, Directory resource or definition");
  assert.equal(mock.state.deployments.size, published);
});

function manifestPath(pack) {
  return path.join(pack, "pack.json");
}

test("two versions install in order and a lower version is refused", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const base = await withPackCopy();
  const first = await executablePlanFor(base.pack);
  const installed = await installPack({ plan: first, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(installed.outcome, "installed");

  const higher = await withPackCopy(async pack => {
    const manifest = JSON.parse(await readFile(manifestPath(pack), "utf8"));
    manifest.version = "0.3.0";
    await writeFile(manifestPath(pack), JSON.stringify(manifest, null, 2));
  });
  const upgrade = await executablePlanFor(higher.pack);
  const upgraded = await installPack({ plan: upgrade, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(upgraded.outcome, "installed");
  assert.equal(upgraded.record.version, "0.3.0");

  const checkpoint = mock.requests.length;
  const lower = await withPackCopy(async pack => {
    const manifest = JSON.parse(await readFile(manifestPath(pack), "utf8"));
    manifest.version = "0.1.0";
    await writeFile(manifestPath(pack), JSON.stringify(manifest, null, 2));
  });
  const rewind = await executablePlanFor(lower.pack);
  await assert.rejects(
    installPack({ plan: rewind, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.VERSION_NOT_GREATER,
  );
  await base.cleanup();
  await higher.cleanup();
  await lower.cleanup();
  assert.ok(mock.requests.slice(checkpoint).every(request =>
    request.method === "GET" || request.path.endsWith("/openid-connect/token") ||
    (request.method === "PUT" && request.path === "/v2/data-schemas/ws_packs")),
    "the refused downgrade must have made no effect beyond the desired-state schema replay");
});

test("a reservation changed underneath the finalize is reconciled by rerunning the same command", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const { pack, cleanup } = await withPackCopy();
  const plan = await executablePlanFor(pack);
  mock.state.faults.raceFinalize = true;
  await assert.rejects(
    installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.RECORD_PRECONDITION,
  );
  assert.equal(mock.state.deployments.size, 2);
  const outcome = await installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  await cleanup();
  assert.equal(outcome.outcome, "installed");
  assert.equal(outcome.record.status, "available");
  assert.equal(mock.state.deployments.size, 2, "the rerun must replay the publications, not deploy them again");
  const record = [...mock.state.records.get(WS_PACKS_COLLECTION).values()][0];
  assert.equal(record.data.status, "available");
});

test("a reused reservation request key with a different body is refused, never resolved with a fresh key", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const { pack, cleanup } = await withPackCopy();
  const plan = await executablePlanFor(pack);
  const reservation = plan.steps.find(step => step.kind === "ws_packs.reservation.create");
  mock.state.idempotency.set(`${WS_PACKS_COLLECTION} ${recordKeyFor("education", "0.2.0")} ${reservation.idempotencyKey}`,
    { digest: JSON.stringify({ ifMatch: null, data: { key: "poisoned" } }), status: 201, body: { id: "poisoned" }, etag: 1 });
  await assert.rejects(
    installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.RECORD_IDEMPOTENCY_CONFLICT,
  );
  await cleanup();
  assert.equal(mock.state.deployments.size, 0);
});

test("a non-console-admin or foreign operator token mutates nothing (fail closed)", async t => {
  const viewer = await startMockCore({
    operatorIdentity: { subject: "ops", tenantId: TENANT, consoleRole: "viewer", roles: ["core-reader"] },
  });
  t.after(() => viewer.close());
  const { pack: packA, cleanup: cleanupA } = await withPackCopy();
  const planA = await executablePlanFor(packA);
  await assert.rejects(
    installPack({ plan: planA, config: lifecycleConfig(viewer), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.OPERATOR_IDENTITY_REJECTED && error.uncertain !== true,
  );
  assert.equal(viewer.requests.filter(request => request.method === "PUT" || request.method === "POST").length, 0,
    "no schema, record, Directory or token write may happen before the operator is verified");
  await cleanupA();

  const foreign = await startMockCore({
    operatorToken: "another-operator-token",
  });
  t.after(() => foreign.close());
  const { pack: packB, cleanup: cleanupB } = await withPackCopy();
  const planB = await executablePlanFor(packB);
  await assert.rejects(
    installPack({ plan: planB, config: lifecycleConfig(foreign), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.OPERATOR_IDENTITY_REJECTED,
  );
  assert.equal(foreign.requests.filter(request => request.method === "PUT" || request.method === "POST").length, 0);
  await cleanupB();
});

test("a console-admin operator without the enrolled directory.write permission mutates nothing and the 403 is preserved", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const { pack, cleanup } = await withPackCopy();
  const plan = await executablePlanFor(pack);
  mock.state.faults.operatorDirectoryWrite = true;
  await assert.rejects(
    installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.OPERATOR_IDENTITY_REJECTED && error.uncertain !== true &&
      /directory\.write/.test(error.message) && /403/.test(error.message),
  );
  await cleanup();
  assert.equal([...mock.state.records.keys()].filter(collection => collection.startsWith("ws_")).length, 0,
    "no ws_packs record may exist");
  assert.ok(mock.requests.every(request => request.method !== "PUT" &&
    !(request.method === "POST" && (request.path === "/v1/workflows/definitions" || request.path.startsWith("/v1/directory/")))),
    "the refused install must not touch ws_packs, Directory or Flowable state");
  const preflight = mock.requests.find(request => request.method === "GET" && request.path === "/v1/directory/unit-types");
  assert.ok(preflight, "the refusal must come from the narrow directory.write type-list preflight");
});

test("a backend application that is not an enrolled core-writer of the tenant owns nothing", async t => {
  const mock = await startMockCore({
    appIdentity: { subject: "pack-backend", tenantId: "tenant-khac", roles: ["core-writer"] },
  });
  t.after(() => mock.close());
  const { pack, cleanup } = await withPackCopy();
  const plan = await executablePlanFor(pack);
  await assert.rejects(
    installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.BACKEND_IDENTITY_REJECTED,
  );
  assert.equal(mock.requests.filter(request => request.method === "PUT" ||
    (request.method === "POST" && !request.path.endsWith("/openid-connect/token"))).length, 0);
  await cleanup();
});

test("inspection distinguishes an absent collection, incomplete and complete installs, and refuses inaccessible data", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const config = lifecycleConfig(mock);
  const fresh = await listInstalledPacks({ config, attempts: 3, delayMs: 1 });
  assert.deepEqual(fresh, { outcome: "listed", collection: "absent", packs: [] },
    "a fresh owner scope is an empty listing, not an error");

  const { pack, cleanup } = await withPackCopy();
  const plan = await executablePlanFor(pack);
  mock.state.faults.directoryFail = true;
  await assert.rejects(installPack({ plan, config, attempts: 2, delayMs: 1 }), error => error.code === CODE.PENDING_NOT_SETTLED);
  const partial = await listInstalledPacks({ config, attempts: 3, delayMs: 1 });
  assert.equal(partial.collection, "populated");
  assert.equal(partial.packs.length, 1);
  assert.equal(partial.packs[0].complete, false);
  assert.equal(partial.packs[0].status, "installing");
  assert.equal(partial.packs[0].version, "0.2.0");

  mock.state.faults.directoryFail = false;
  await installPack({ plan, config, attempts: 3, delayMs: 1 });
  const complete = await listInstalledPacks({ config, attempts: 3, delayMs: 1 });
  assert.equal(complete.packs[0].complete, true);
  assert.equal(complete.packs[0].status, "available");
  assert.equal(complete.packs[0].definitions.length, 2);
  assert.ok(complete.packs[0].definitions.every(entry => entry.definitionId && entry.definitionVersion === 1));

  mock.state.faults.dataForbidden = true;
  await assert.rejects(listInstalledPacks({ config, attempts: 3, delayMs: 1 }),
    error => error.code === CODE.UPSTREAM_REJECTED && error.uncertain !== true,
    "inaccessible data must be reported, never read as nothing installed");
  await cleanup();
});

test("a publication reply without the exact requested key and a usable {id, key, version} stops the run before finalizing", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const { pack, cleanup } = await withPackCopy();
  const plan = await executablePlanFor(pack);
  mock.state.faults.publishBadReply = 3;
  await assert.rejects(
    installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.PENDING_NOT_SETTLED && error.uncertain === true,
  );
  await cleanup();
  assert.equal(mock.state.deployments.size, 0,
    "a workflow whose every reply is unusable must not be counted as deployed");
  const record = [...mock.state.records.get(WS_PACKS_COLLECTION).values()][0];
  assert.equal(record.data.status, "installing", "an unusable publication reply must never finalize the reservation");
  assert.ok(!mock.requests.some(request => request.method === "PUT" &&
    request.path.startsWith(`/v2/data/${WS_PACKS_COLLECTION}/by-key/`) && request.body?.data?.status === "available"),
    "no finalize replace may happen after an unusable publication reply");
});

test("a legitimate long prerelease version installs without being dropped", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  // The manifest schema bounds versions by pattern alone, with no length cap;
  // the ws_packs record schema must accept every manifest-safe version, and
  // the record key falls back to its hash form above the pinned 128 chars.
  const longVersion = `1.2.3-${"a".repeat(70)}`;
  const { pack, cleanup } = await withPackCopy(async packDir => {
    const manifest = JSON.parse(await readFile(manifestPath(packDir), "utf8"));
    manifest.version = longVersion;
    await writeFile(manifestPath(packDir), JSON.stringify(manifest, null, 2));
  });
  const plan = await executablePlanFor(pack);
  const outcome = await installPack({ plan, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(outcome.outcome, "installed");
  assert.equal(outcome.record.version, longVersion);
  const record = [...mock.state.records.get(WS_PACKS_COLLECTION).values()][0];
  assert.equal(record.data.key, recordKeyFor("education", longVersion));
  assert.match(record.data.key, /^[A-Za-z0-9_-]{1,128}$/, "the hashed record key must still fit the pinned uniqueKey shape");
  const listed = await listInstalledPacks({ config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.deepEqual(listed.packs.map(entry => [entry.packId, entry.version, entry.complete]),
    [["education", longVersion, true]]);
  await cleanup();
});

test("the CLI installs for real and lists the installed version; missing configuration refuses without effect", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const env = {
    ...process.env,
    JUNCTURA_URL: mock.url,
    JUNCTURA_TENANT: TENANT,
    JUNCTURA_APP_CLIENT_ID: CLIENT_ID,
    JUNCTURA_APP_CLIENT_SECRET: CLIENT_SECRET,
    JUNCTURA_OPERATOR_TOKEN: OPERATOR_TOKEN,
  };
  // The mock Core lives in this process's event loop, so the CLI must run as
  // an asynchronous child: a synchronous spawn would block the loop and leave
  // the child's HTTP requests unanswered.
  const run = (args, options = {}) => new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env, ...options });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => resolve({ status, stdout, stderr }));
  });

  const { pack, cleanup } = await withPackCopy();
  const installed = await run([pack], { timeout: 30_000 });
  assert.equal(installed.status, 0, `expected exit 0, got ${installed.status} with stderr ${installed.stderr}`);
  const result = JSON.parse(installed.stdout);
  assert.equal(result.ok, true);
  assert.equal(result.outcome, "installed");
  assert.equal(result.pack.id, "education");
  assert.match(result.pack.contentHash, /^[0-9a-f]{64}$/);
  assert.equal(result.record.status, "available");

  const listed = await run(["--list"], { timeout: 30_000 });
  assert.equal(listed.status, 0, `expected exit 0, got ${listed.status} with stderr ${listed.stderr}`);
  const listing = JSON.parse(listed.stdout);
  assert.equal(listing.collection, "populated");
  assert.deepEqual(listing.packs.map(entry => [entry.packId, entry.version, entry.complete]), [["education", "0.2.0", true]]);
  await cleanup();

  const refused = await run([EDUCATION], { timeout: 30_000, env: { ...env, JUNCTURA_URL: "", JUNCTURA_TENANT: "" } });
  assert.equal(refused.status, 3, "missing configuration is a refusal, distinct from invalid input");
  assert.equal(refused.stdout, "");
  assert.match(refused.stderr, /Nothing was changed/);

  assert.equal((await run(["--list", EDUCATION])).status, 2, "--list takes no pack directory");
  assert.equal((await run([EDUCATION, "--dry-run", "--list"])).status, 2, "--list cannot be combined with --dry-run");
  assert.equal((await run([EDUCATION, "--wet"])).status, 2, "unknown options stay usage errors");
});
