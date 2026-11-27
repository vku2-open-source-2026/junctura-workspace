// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Contract tests of durable pack selection and safe retirement (issue #12
// closing slice, server/pack-lifecycle.mjs). Everything runs against a mock of
// the exact pinned DX-OS wire surface on the HTTP loopback: client-credentials
// tokens, GET /v1/identity per bearer, desired-state schema registration,
// filtered lists with cursor pagination, by-key upsert with the pinned
// If-Match/428/412 semantics, and POST /v2/data:batch with the pinned
// all-or-nothing transaction semantics — strong per-record ETags in the pinned
// `"record-<64hex>-<version>"` shape, one receipt per Idempotency-Key digesting
// the whole logical request including every write precondition, 412 on a stale
// precondition, 422 idempotency_key_reused on a changed request, 409
// unique_key_conflict and 503 without a receipt. Installed versions are seeded
// straight into the owner scope (the install path is covered by
// pack-lifecycle.test.mjs), so these tests focus on selection and retirement.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJuncturaClient } from "@junctura/server-client";
import {
  PackLifecycleErrorCode,
  SELECTION_RECORD_KEY,
  WS_PACKS_COLLECTION,
  WS_PACKS_SCHEMA,
  WS_PACK_SELECTIONS_COLLECTION,
  WS_PACK_SELECTIONS_SCHEMA,
  listInstalledPacks,
  packContentHash,
  recordKeyFor,
  retirePackVersion,
  selectPackVersion,
} from "../pack-lifecycle.mjs";
import { readPack } from "../packs.mjs";

const CODE = PackLifecycleErrorCode;
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = path.join(ROOT, "scripts", "pack-install.mjs");
const EDUCATION = path.join(ROOT, "examples", "packs", "education");

const TENANT = "tenant-so-1";
const CLIENT_ID = "ws-pack-backend";
const CLIENT_SECRET = "ws-pack-backend-secret";
const OPERATOR_TOKEN = "operator-console-admin-token";

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** The CLI logs progress on stderr before an error payload; extract the JSON. */
const errorPayloadOf = stderr => JSON.parse(stderr.slice(stderr.indexOf("{")));

/** A seeded ws_packs record body, shaped exactly like a finalized install. */
function packRecordData({ packId, version, status, contentHash, definitions = [], directory = { unitTypes: [], units: [], groups: [] } }) {
  return { key: recordKeyFor(packId, version), packId, version, status, contentHash, definitions, directory };
}

/**
 * A stateful mock of the pinned DX-OS record surface on the HTTP loopback.
 * Faults are configurable between runs, and an armed hold gates the NEXT
 * batch transaction so two racing commands can be interleaved
 * deterministically: the held request sits inside Core between read and
 * commit, exactly like a real concurrent writer.
 */
async function startMockCore({
  tenant = TENANT,
  operatorToken = OPERATOR_TOKEN,
  operatorIdentity = { subject: "ops-admin", tenantId: tenant, consoleRole: "admin", roles: ["core-writer", "core-reader"] },
  appIdentity = { subject: "pack-backend", tenantId: tenant, roles: ["core-writer", "core-reader"] },
} = {}) {
  const state = {
    schemas: new Map(),
    collections: new Map(),
    idempotency: new Map(),
    appTokens: new Map(),
    appCounter: 0,
    recordCounter: 0,
    faults: { batchUnavailable: 0, batchReplyConflict: 0, holdNextBatch: null, hideSelectionFromListOnce: false, retireTargetBeforeNextGet: false },
  };
  const requests = [];
  const schemaOf = collection => state.schemas.get(collection)?.schema ?? null;

  const fingerprintOf = (collection, id) => createHash("sha256").update(`${collection}/${id}`).digest("hex");
  const etagOf = (collection, record) => `"record-${fingerprintOf(collection, record.id)}-${record.version}"`;
  const recordBody = (collection, record) => ({ id: record.id, collection, data: record.data });

  /** A compact Core-side record validator: objects, arrays, strings, patterns, enums. */
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
    if (schemaPart.enum && !schemaPart.enum.includes(value)) problems.push(`${at} outside its enum`);
    return problems;
  };

  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", chunk => chunks.push(chunk));
    request.on("end", async () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const url = new URL(request.url, "http://loopback");
      const route = url.pathname;
      const query = url.searchParams;
      const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? "")?.[1] ?? null;
      let parsedBody = null;
      try {
        parsedBody = body ? JSON.parse(body) : null;
      } catch {
        parsedBody = body;
      }
      requests.push({
        method: request.method,
        path: route,
        query: url.search,
        idempotencyKey: request.headers["idempotency-key"] ?? null,
        ifMatch: request.headers["if-match"] ?? null,
        body: parsedBody,
      });

      const json = (status, payload, headers = {}) => {
        response.writeHead(status, { "content-type": "application/json", ...headers });
        response.end(JSON.stringify(payload));
      };
      const appIdentityOf = bearer !== null && state.appTokens.has(bearer) ? state.appTokens.get(bearer) : null;

      if (request.method === "POST" && route === "/identity/realms/junctura/protocol/openid-connect/token") {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") !== "client_credentials" || form.get("client_id") !== CLIENT_ID || form.get("client_secret") !== CLIENT_SECRET) {
          return json(401, { error: "authentication_failed" });
        }
        const token = `app-token-${++state.appCounter}`;
        state.appTokens.set(token, appIdentity);
        return json(200, { access_token: token, token_type: "Bearer", expires_in: 300 });
      }

      if (request.method === "GET" && route === "/v1/identity") {
        if (bearer === operatorToken) return json(200, operatorIdentity);
        if (appIdentityOf) return json(200, appIdentityOf);
        return json(401, { error: "not_authenticated" });
      }

      if (/^\/v2\//.test(route) && !appIdentityOf) return json(401, { error: "not_authenticated" });

      if (request.method === "PUT" && /^\/v2\/data-schemas\/[^/]+$/.test(route)) {
        const collection = route.slice("/v2/data-schemas/".length);
        const schema = JSON.parse(body);
        if (state.schemas.has(collection)) {
          if (JSON.stringify(state.schemas.get(collection)) === JSON.stringify(schema)) return json(200, { collection });
          // The pinned registerCollectionSchema is the record-retaining
          // migration: validate every existing record against the new schema
          // and rebuild the registration in one step, or refuse without it.
          const problems = [];
          for (const record of state.collections.get(collection)?.values() ?? []) {
            problems.push(...validateRecordData(schema.schema, record.data, `/records/${record.id}/data`));
          }
          if (problems.length) return json(422, { error: "schema_violation", issues: problems.map(problem => ({ path: problem })) });
          state.schemas.set(collection, schema);
          return json(200, { collection });
        }
        state.schemas.set(collection, schema);
        state.collections.set(collection, new Map());
        return json(201, { collection });
      }

      // The pinned batch transaction: 1–50 operations applied in request order
      // in ONE transaction, every replace conditioned on the current record
      // ETag, one receipt per Idempotency-Key digesting the whole logical
      // request (including every write precondition), and any failure rolls
      // the whole batch back.
      if (request.method === "POST" && route === "/v2/data:batch") {
        const idempotencyKey = request.headers["idempotency-key"];
        if (!idempotencyKey) return json(400, { error: "invalid_request" });
        const digest = JSON.stringify(parsedBody?.operations ?? null);
        const seen = state.idempotency.get(`batch ${idempotencyKey}`);
        if (seen) {
          return seen.digest === digest ? json(seen.status, seen.body) : json(422, { error: "idempotency_key_reused" });
        }
        if (state.faults.batchUnavailable > 0) {
          state.faults.batchUnavailable--;
          return json(503, { error: "data_unavailable" });
        }
        if (state.faults.batchReplyConflict > 0) {
          state.faults.batchReplyConflict--;
          const conflict = { error: "idempotency_key_reused" };
          state.idempotency.set(`batch ${idempotencyKey}`, { digest, status: 422, body: conflict });
          return json(422, conflict);
        }
        if (state.faults.holdNextBatch) {
          const hold = state.faults.holdNextBatch;
          state.faults.holdNextBatch = null;
          try {
            await hold;
          } catch {
            return json(504, { error: "gate_timeout" });
          }
        }
        const operations = parsedBody?.operations;
        if (!Array.isArray(operations) || operations.length < 1 || operations.length > 50) {
          return json(400, { error: "invalid_request" });
        }
        // Scratch copy: nothing is visible until the whole batch succeeds.
        const scratch = new Map();
        for (const [collection, records] of state.collections) {
          scratch.set(collection, new Map([...records].map(([key, record]) => [key, { ...record }])));
        }
        const fail = (status, payload) => {
          state.idempotency.set(`batch ${idempotencyKey}`, { digest, status, body: payload });
          return json(status, payload);
        };
        const results = [];
        for (const operation of operations) {
          const store = scratch.get(operation?.collection);
          if (!store) return fail(404, { error: "not_found" });
          if (operation.op === "create") {
            const uniqueKey = state.schemas.get(operation.collection)?.uniqueKey ?? "key";
            if ([...store.values()].some(record => record.data[uniqueKey] === operation.data?.[uniqueKey])) {
              return fail(409, { error: "unique_key_conflict" });
            }
            const problems = schemaOf(operation.collection)
              ? validateRecordData(schemaOf(operation.collection), operation.data, "/data")
              : [];
            if (problems.length) return fail(422, { error: "schema_violation", issues: problems.map(problem => ({ path: problem })) });
            const record = { id: `rec-${++state.recordCounter}`, version: 1, data: operation.data };
            store.set(record.data[uniqueKey], record);
            results.push({ op: "create", id: record.id, version: 1 });
          } else if (operation.op === "replace") {
            const record = [...store.values()].find(item => item.id === operation.id);
            if (!record || etagOf(operation.collection, record) !== operation.ifMatch) {
              return fail(412, { error: "precondition_failed" });
            }
            const problems = schemaOf(operation.collection)
              ? validateRecordData(schemaOf(operation.collection), operation.data, "/data")
              : [];
            if (problems.length) return fail(422, { error: "schema_violation", issues: problems.map(problem => ({ path: problem })) });
            record.data = operation.data;
            record.version += 1;
            results.push({ op: "replace", id: record.id, version: record.version });
          } else {
            return fail(400, { error: "invalid_request" });
          }
        }
        state.collections = scratch;
        const payload = { results };
        state.idempotency.set(`batch ${idempotencyKey}`, { digest, status: 200, body: payload });
        return json(200, payload);
      }

      const dataMatch = /^\/v2\/data\/([^/]+)(\/by-key\/[^/]+|\/[^/]+)?$/.exec(route);
      if (dataMatch) {
        const collection = decodeURIComponent(dataMatch[1]);
        const rest = dataMatch[2] ?? "";

        if (request.method === "GET" && rest === "") {
          const filtered = [...query.keys()].some(key => /^where\[/.test(key));
          if (!state.schemas.has(collection)) {
            // Real Core rejects a filtered query when the collection schema
            // (and therefore its index) does not exist yet; a plain unfiltered
            // read of an absent collection is 404. A read-only listing must
            // work on a fresh owner, so it may never rely on a filter.
            return filtered ? json(400, { error: "invalid_query" }) : json(404, { error: "collection_not_found" });
          }
          if (collection === WS_PACK_SELECTIONS_COLLECTION && state.faults.hideSelectionFromListOnce) {
            state.faults.hideSelectionFromListOnce = false;
            return json(200, { items: [] });
          }
          let items = [...state.collections.get(collection).values()];
          for (const [key, value] of query) {
            const where = /^where\[(.+)\]$/.exec(key);
            if (!where) continue;
            if (!value.startsWith("eq:")) return json(400, { error: "unsupported_filter" });
            const expected = JSON.parse(value.slice(3));
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
          for (const record of state.collections.get(collection)?.values() ?? []) {
            if (record.id !== id) continue;
            // A concurrent retirement can commit after the list snapshot but
            // before this per-record read; the fault models exactly that.
            if (collection === WS_PACKS_COLLECTION && state.faults.retireTargetBeforeNextGet) {
              state.faults.retireTargetBeforeNextGet = false;
              record.data = { ...record.data, status: "retired" };
              record.version += 1;
            }
            return json(200, recordBody(collection, record), { etag: etagOf(collection, record) });
          }
          return json(404, { error: "record_not_found" });
        }

        if (request.method === "PUT" && rest.startsWith("/by-key/")) {
          const key = decodeURIComponent(rest.slice("/by-key/".length));
          const idempotencyKey = request.headers["idempotency-key"];
          if (!idempotencyKey) return json(400, { error: "invalid_request" });
          const { data } = JSON.parse(body);
          const digest = JSON.stringify({ ifMatch: request.headers["if-match"] ?? null, data });
          const seen = state.idempotency.get(`${collection} ${key} ${idempotencyKey}`);
          if (seen) {
            if (seen.digest !== digest) return json(422, { error: "idempotency_key_reused" });
            return json(seen.status, seen.body, seen.etag ? { etag: seen.etag } : {});
          }
          const existing = state.collections.get(collection)?.get(key);
          const ifMatch = request.headers["if-match"] ?? null;
          if (existing) {
            if (ifMatch === null) return json(428, { error: "precondition_required" });
            if (ifMatch !== etagOf(collection, existing)) return json(412, { error: "precondition_failed" });
          } else if (ifMatch !== null) {
            return json(412, { error: "precondition_failed" });
          }
          const problems = schemaOf(collection) ? validateRecordData(schemaOf(collection), data, "/data") : [];
          if (problems.length) return json(422, { error: "schema_violation", issues: problems.map(problem => ({ path: problem })) });
          const upserted = existing ?? { id: `rec-${++state.recordCounter}`, version: 0, data: null };
          upserted.data = data;
          upserted.version += 1;
          state.collections.get(collection).set(key, upserted);
          const status = existing ? 200 : 201;
          const responseBody = recordBody(collection, upserted);
          const etag = etagOf(collection, upserted);
          state.idempotency.set(`${collection} ${key} ${idempotencyKey}`, { digest, status, body: responseBody, etag });
          return json(status, responseBody, { etag });
        }
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

/** Seeds one installed version straight into the owner scope, like a finished install. */
function seedInstalledPack(mock, { packId, version, status = "available", contentHash, definitions, directory }) {
  if (!mock.state.schemas.has(WS_PACKS_COLLECTION)) {
    mock.state.schemas.set(WS_PACKS_COLLECTION, WS_PACKS_SCHEMA);
    mock.state.collections.set(WS_PACKS_COLLECTION, new Map());
  }
  const key = recordKeyFor(packId, version);
  const record = { id: `rec-${++mock.state.recordCounter}`, version: 1, data: packRecordData({ packId, version, status, contentHash, definitions, directory }) };
  mock.state.collections.get(WS_PACKS_COLLECTION).set(key, record);
  return record;
}

/**
 * Arms a hold on the NEXT batch transaction and returns its release handle.
 * The gate fails after a bounded wait so a test that never releases it cannot
 * hang the run, and releasing twice is a harmless no-op.
 */
function holdNextBatch(mock, timeoutMs = 5000) {
  let release;
  const hold = new Promise((resolve, reject) => {
    release = resolve;
    setTimeout(() => reject(new Error("the held batch gate was never released")), timeoutMs).unref?.();
  });
  mock.state.faults.holdNextBatch = hold;
  return release;
}

/** Waits until a batch addressing the target version (any status) has arrived at Core. */
async function awaitBatchFor(mock, version) {
  for (let waited = 0; waited < 5000; waited += 5) {
    const arrived = mock.requests.some(request => request.method === "POST" && request.path === "/v2/data:batch" &&
      request.body?.operations?.some(operation => operation?.collection === WS_PACKS_COLLECTION &&
        operation?.data?.version === version));
    if (arrived) return;
    await sleep(5);
  }
  throw new Error(`the batch addressing ${version} never arrived at the mock Core`);
}

const CONTENT_A = "a".repeat(64);
const CONTENT_B = "b".repeat(64);
const etagFor = (collection, record) => `"record-${createHash("sha256").update(`${collection}/${record.id}`).digest("hex")}-${record.version}"`;
const DEFINITIONS = [
  { workflow: "chuyentruong", key: "chuyentruong", definitionId: "def-1", definitionVersion: 1 },
  { workflow: "capbansaohocba", key: "capbansaohocba", definitionId: "def-2", definitionVersion: 1 },
];
const DIRECTORY = { unitTypes: ["truong"], units: ["truong-tieu-hoc-a1"], groups: [{ unit: "truong-tieu-hoc-a1", group: "hoc-vu" }] };

test("the ws_pack_selections schema uses only the pinned Core regex subset and is registered before any selection state is touched", async t => {
  const patterns = [];
  const walk = value => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (value !== null && typeof value === "object") {
      if (typeof value.pattern === "string") patterns.push(value.pattern);
      Object.values(value).forEach(walk);
    }
  };
  walk(WS_PACK_SELECTIONS_SCHEMA);
  assert.ok(patterns.length > 0);
  for (const pattern of patterns) {
    assert.doesNotMatch(pattern, /[()|\\]/, `${pattern} leaves the pinned subset`);
    assert.doesNotThrow(() => new RegExp(pattern));
  }
  assert.equal(WS_PACK_SELECTIONS_SCHEMA.uniqueKey, "key");
  assert.ok(WS_PACK_SELECTIONS_SCHEMA.indexed.includes("key"), "the key field stays indexed for owner-scoped lookups");

  const mock = await startMockCore();
  t.after(() => mock.close());
  seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A });
  const outcome = await selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(outcome.outcome, "selected");
  const registration = mock.requests.findIndex(request => request.method === "PUT" && request.path === `/v2/data-schemas/${WS_PACK_SELECTIONS_COLLECTION}`);
  const firstSelectionRead = mock.requests.findIndex(request => request.path.startsWith(`/v2/data/${WS_PACK_SELECTIONS_COLLECTION}`));
  assert.ok(registration !== -1 && firstSelectionRead > registration, "the owner index only exists after registration");
  assert.deepEqual(mock.requests[registration].body, WS_PACK_SELECTIONS_SCHEMA);
});

test("a fresh stack lists no selection without registering or filtering, and the first select swaps the empty pointer with an atomic same-data target validation", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());

  // Read-only listing on a brand-new owner: the collection schema/index does
  // not exist yet, so the listing must be an unfiltered read that Core accepts
  // (a filtered query there is 400 invalid_query, as the real runtime showed)
  // and --list must never register the schema just to read.
  const fresh = await listInstalledPacks({ config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.deepEqual(fresh, { outcome: "listed", collection: "absent", selection: null, packs: [] });
  assert.ok(!mock.requests.some(request => request.method === "PUT" && request.path.startsWith("/v2/data-schemas/")),
    "a read-only listing must not register any schema");
  assert.ok(!mock.requests.some(request => request.query.includes("where[")),
    "the listing must not use a filtered query");
  const client = createJuncturaClient({ baseUrl: mock.url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await assert.rejects(
    client.request(`/v2/data/${WS_PACK_SELECTIONS_COLLECTION}?limit=2&where[key]=eq:%22active%22`),
    error => error.status === 400 && error.code === "invalid_query",
    "the mock (like the real Core) rejects a filtered query on an unregistered collection",
  );
  await assert.rejects(
    client.request(`/v2/data/${WS_PACK_SELECTIONS_COLLECTION}?limit=2`),
    error => error.status === 404,
    "an unfiltered read of an absent collection is a real 404, not a query error",
  );

  const target = seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A, definitions: DEFINITIONS, directory: DIRECTORY });
  const outcome = await selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(outcome.outcome, "selected");
  assert.deepEqual(outcome.selection, { packId: "education", version: "0.2.0", contentHash: CONTENT_A });

  const batch = mock.requests.find(request => request.path === "/v2/data:batch");
  assert.ok(batch, "the selection must commit as one atomic batch");
  assert.equal(batch.body.operations.length, 2);
  const [pointer, revalidate] = batch.body.operations;
  assert.deepEqual(pointer, {
    op: "replace", collection: WS_PACK_SELECTIONS_COLLECTION, id: batch.body.operations[0].id,
    ifMatch: pointer.ifMatch, data: { key: SELECTION_RECORD_KEY, packId: "education", version: "0.2.0", contentHash: CONTENT_A },
  });
  assert.match(pointer.ifMatch, /^"record-[0-9a-f]{64}-1"$/, "the pointer swap carries the strong ETag of the bootstrapped record");
  assert.deepEqual(revalidate.data, target.data, "the target is re-validated with a same-data replacement");
  assert.equal(revalidate.ifMatch, `"record-${createHash("sha256").update(`${WS_PACKS_COLLECTION}/${target.id}`).digest("hex")}-1"`);
  assert.match(batch.idempotencyKey, /^[0-9a-f-]{36}$/);

  const listed = await listInstalledPacks({ config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(listed.selection.packId, "education");
  assert.equal(listed.selection.version, "0.2.0");
  assert.deepEqual(listed.packs.map(entry => [entry.version, entry.selected, entry.complete]), [["0.2.0", true, true]]);
  const record = [...mock.state.collections.get(WS_PACKS_COLLECTION).values()][0];
  assert.equal(record.data.status, "available", "selecting never rewrites the target's durable data");
});

test("two available versions activate and switch, and exactly one selection record stays current per app", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A, definitions: DEFINITIONS, directory: DIRECTORY });
  seedInstalledPack(mock, { packId: "education", version: "0.3.0", contentHash: CONTENT_B, definitions: DEFINITIONS, directory: DIRECTORY });

  const seeded = await listInstalledPacks({ config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(seeded.selection, null);
  assert.deepEqual(seeded.packs.map(entry => [entry.version, entry.selected]), [["0.3.0", false], ["0.2.0", false]]);

  const first = await selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(first.outcome, "selected");
  const switched = await selectPackVersion({ packId: "education", version: "0.3.0", contentHash: CONTENT_B, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(switched.outcome, "selected");
  assert.deepEqual(switched.selection, { packId: "education", version: "0.3.0", contentHash: CONTENT_B });

  const selectionRecords = [...mock.state.collections.get(WS_PACK_SELECTIONS_COLLECTION).values()];
  assert.equal(selectionRecords.length, 1, "one current selection record per app");
  assert.deepEqual(selectionRecords[0].data, { key: SELECTION_RECORD_KEY, packId: "education", version: "0.3.0", contentHash: CONTENT_B });

  const listed = await listInstalledPacks({ config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.deepEqual(listed.packs.map(entry => [entry.version, entry.selected, entry.status]), [["0.3.0", true, "available"], ["0.2.0", false, "available"]]);

  const back = await selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(back.outcome, "selected");
  assert.equal(back.selection.version, "0.2.0");
});

test("the same select and retire actions replay without new writes", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A, definitions: DEFINITIONS, directory: DIRECTORY });
  seedInstalledPack(mock, { packId: "education", version: "0.3.0", contentHash: CONTENT_B, definitions: DEFINITIONS, directory: DIRECTORY });

  await selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  const checkpoint = mock.requests.length;
  const selectionVersion = [...mock.state.collections.get(WS_PACK_SELECTIONS_COLLECTION).values()][0].version;
  const replay = await selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(replay.outcome, "replayed");
  assert.deepEqual(replay.selection, { packId: "education", version: "0.2.0", contentHash: CONTENT_A });
  assert.ok(mock.requests.slice(checkpoint).every(request => request.path !== "/v2/data:batch"),
    "a replayed select must not write again");
  assert.equal([...mock.state.collections.get(WS_PACK_SELECTIONS_COLLECTION).values()][0].version, selectionVersion,
    "the replay must not rewrite the selection record");

  await selectPackVersion({ packId: "education", version: "0.3.0", contentHash: CONTENT_B, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  const retired = await retirePackVersion({ packId: "education", version: "0.2.0", config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(retired.outcome, "retired");
  const retiredCheckpoint = mock.requests.length;
  const retiredReplay = await retirePackVersion({ packId: "education", version: "0.2.0", config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(retiredReplay.outcome, "replayed");
  assert.deepEqual(retiredReplay.record.status, "retired");
  assert.ok(mock.requests.slice(retiredCheckpoint).every(request => request.path !== "/v2/data:batch"),
    "a replayed retirement must not write again");
});

test("a cached bootstrap receipt is never current authority: a later selection reads back the committed pointer and current ETag", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A });
  seedInstalledPack(mock, { packId: "education", version: "0.3.0", contentHash: CONTENT_B });

  const first = await selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(first.outcome, "selected");

  // Core now caches the constant bootstrap receipt (empty pointer, version 1,
  // original ETag). Hide the record from the next selection list, as a racing
  // process whose first read ran before the record existed would: the command
  // re-sends the bootstrap key, Core replays the ORIGINAL 201 body/ETag, and
  // the command must read the CURRENT record back before swapping.
  mock.state.faults.hideSelectionFromListOnce = true;
  const second = await selectPackVersion({ packId: "education", version: "0.3.0", contentHash: CONTENT_B, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(second.outcome, "selected");
  assert.equal(second.selection.version, "0.3.0");

  const bootstrapPuts = mock.requests.filter(request => request.method === "PUT" && request.path.includes("/by-key/"));
  assert.equal(bootstrapPuts.length, 2, "the second command really did re-send the bootstrap key and receive the cached reply");
  const secondBatch = mock.requests.findLast(request => request.path === "/v2/data:batch");
  assert.match(secondBatch.body.operations[0].ifMatch, /-2"$/,
    "the swap preconditions on the CURRENT record version, never on the replayed receipt ETag");
  assert.deepEqual([...mock.state.collections.get(WS_PACK_SELECTIONS_COLLECTION).values()][0].data,
    { key: SELECTION_RECORD_KEY, packId: "education", version: "0.3.0", contentHash: CONTENT_B });
});

test("a retirement committed between the list snapshot and the per-record read is never selectable, and is a replay for retire", async t => {
  for (const retiring of [false, true]) {
    const mock = await startMockCore();
    seedInstalledPack(mock, { packId: "education", version: "0.3.0", contentHash: CONTENT_B, definitions: DEFINITIONS, directory: DIRECTORY });
    // The list snapshot still shows "available"; the concurrent retirement
    // commits right before the per-record read (the fault models exactly that
    // window) and advances the record ETag.
    mock.state.faults.retireTargetBeforeNextGet = true;
    if (retiring) {
      const outcome = await retirePackVersion({ packId: "education", version: "0.3.0", config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
      assert.equal(outcome.outcome, "replayed", "the now-current record is already retired, so retirement is a replay");
      assert.equal(outcome.record.status, "retired");
    } else {
      await assert.rejects(
        selectPackVersion({ packId: "education", version: "0.3.0", contentHash: CONTENT_B, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
        error => error.code === CODE.SELECTION_TARGET_INVALID && error.uncertain !== true,
        "a target retired after the list but before the read must never be selected",
      );
      assert.equal(mock.state.collections.has(WS_PACK_SELECTIONS_COLLECTION), false,
        "the refusal happens before the selection record is even bootstrapped");
    }
    assert.equal(mock.requests.filter(request => request.path === "/v2/data:batch").length, 0, "nothing was applied");
    assert.equal(mock.state.collections.get(WS_PACKS_COLLECTION).get(recordKeyFor("education", "0.3.0")).data.status, "retired");
    await mock.close();
  }
});

test("retirement migrates an owner scope registered with the old ws_packs status enum, retaining every old record", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const oldSchema = {
    ...WS_PACKS_SCHEMA,
    schema: {
      ...WS_PACKS_SCHEMA.schema,
      properties: { ...WS_PACKS_SCHEMA.schema.properties, status: { type: "string", enum: ["installing", "available"] } },
    },
  };
  mock.state.schemas.set(WS_PACKS_COLLECTION, oldSchema);
  mock.state.collections.set(WS_PACKS_COLLECTION, new Map());
  const older = seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A, definitions: DEFINITIONS, directory: DIRECTORY });
  seedInstalledPack(mock, { packId: "education", version: "0.3.0", contentHash: CONTENT_B, definitions: DEFINITIONS, directory: DIRECTORY });
  await selectPackVersion({ packId: "education", version: "0.3.0", contentHash: CONTENT_B, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });

  // The old registration really does refuse a "retired" write: the fake Core
  // validates record data against the registered schema, exactly like Core.
  const client = createJuncturaClient({ baseUrl: mock.url, clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  await assert.rejects(
    client.request("/v2/data:batch", {
      method: "POST", idempotencyKey: randomUUID(),
      json: { operations: [{ op: "replace", collection: WS_PACKS_COLLECTION, id: older.id, ifMatch: etagFor(WS_PACKS_COLLECTION, older), data: { ...older.data, status: "retired" } }] },
    }),
    error => error.status === 422 && error.code === "schema_violation",
    "the old enum refuses the first retired write",
  );
  assert.equal(mock.state.collections.get(WS_PACKS_COLLECTION).get(recordKeyFor("education", "0.2.0")).data.status, "available");

  const checkpoint = mock.requests.length;
  const outcome = await retirePackVersion({ packId: "education", version: "0.2.0", config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(outcome.outcome, "retired");
  const registered = mock.state.schemas.get(WS_PACKS_COLLECTION);
  assert.ok(registered.schema.properties.status.enum.includes("retired"), "the current schema was registered before the retired write");
  const registrations = mock.requests.slice(checkpoint)
    .filter(request => request.method === "PUT" && request.path.startsWith("/v2/data-schemas/"))
    .map(request => request.path);
  assert.deepEqual(registrations, [
    `/v2/data-schemas/${WS_PACK_SELECTIONS_COLLECTION}`,
    `/v2/data-schemas/${WS_PACKS_COLLECTION}`,
  ], "one selection registration and one ws_packs migration, never a duplicate selection registration");
  assert.equal(mock.state.collections.get(WS_PACKS_COLLECTION).size, 2, "migration retains every prior record");
  assert.equal(mock.state.collections.get(WS_PACKS_COLLECTION).get(recordKeyFor("education", "0.3.0")).data.status, "available");
  assert.equal(mock.state.collections.get(WS_PACKS_COLLECTION).get(recordKeyFor("education", "0.2.0")).data.status, "retired");
  assert.ok(mock.requests.slice(checkpoint).every(request => !request.path.startsWith("/v1/directory/") &&
    !request.path.startsWith("/v1/workflows/") && request.method !== "DELETE"),
    "the migration and retirement never touch Directory, the engine or delete anything");
});

test("two competing selects commit exactly one pointer; the loser rolls back wholly and a rerun re-observes", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A });
  seedInstalledPack(mock, { packId: "education", version: "0.3.0", contentHash: CONTENT_B });

  const release = holdNextBatch(mock);
  const slower = selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 })
    .then(outcome => ({ settled: "fulfilled", outcome }), error => ({ settled: "rejected", error }));
  let slowerResult;
  try {
    await awaitBatchFor(mock, "0.2.0");
    const faster = await selectPackVersion({ packId: "education", version: "0.3.0", contentHash: CONTENT_B, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
    assert.equal(faster.outcome, "selected");
    release();
    slowerResult = await slower;
  } finally {
    release();
  }
  assert.equal(slowerResult.settled, "rejected");
  assert.equal(slowerResult.error.code, CODE.SELECTION_PRECONDITION);
  assert.equal(slowerResult.error.uncertain, false, "a lost precondition race is a definite rollback, never an uncertainty");
  assert.match(slowerResult.error.message, /rolled back/);

  const selectionRecords = [...mock.state.collections.get(WS_PACK_SELECTIONS_COLLECTION).values()];
  assert.equal(selectionRecords.length, 1);
  assert.equal(selectionRecords[0].data.version, "0.3.0", "exactly one competing select may win");
  const untouched = mock.state.collections.get(WS_PACKS_COLLECTION).get(recordKeyFor("education", "0.2.0"));
  assert.equal(untouched.data.status, "available", "the loser's target re-validation rolled back with the batch");

  const rerun = await selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(rerun.outcome, "selected");
  assert.equal(rerun.selection.version, "0.2.0", "the rerun re-observes the fresh state and competes again");
});

test("a simultaneous select and retire cannot interleave: both pin the same observed pointer ETag, the loser rolls back wholly", async t => {
  for (const retireFirst of [false, true]) {
    const mock = await startMockCore();
    seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A, definitions: DEFINITIONS, directory: DIRECTORY });
    seedInstalledPack(mock, { packId: "education", version: "0.3.0", contentHash: CONTENT_B, definitions: DEFINITIONS, directory: DIRECTORY });
    await selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });

    const release = holdNextBatch(mock);
    const held = (retireFirst
      ? retirePackVersion({ packId: "education", version: "0.3.0", config: lifecycleConfig(mock), attempts: 3, delayMs: 1 })
      : selectPackVersion({ packId: "education", version: "0.3.0", contentHash: CONTENT_B, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 })
    ).then(outcome => ({ settled: "fulfilled", outcome }), error => ({ settled: "rejected", error }));
    let heldResult;
    try {
      await awaitBatchFor(mock, "0.3.0");
      const raced = await (retireFirst
        ? selectPackVersion({ packId: "education", version: "0.3.0", contentHash: CONTENT_B, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 })
        : retirePackVersion({ packId: "education", version: "0.3.0", config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }));
      if (retireFirst) assert.equal(raced.outcome, "selected");
      else assert.equal(raced.outcome, "retired");
      release();
      heldResult = await held;
    } finally {
      release();
    }
    assert.equal(heldResult.settled, "rejected", "the loser must lose atomically, never partially");
    assert.equal(heldResult.error.code, retireFirst ? CODE.RETIRE_PRECONDITION : CODE.SELECTION_PRECONDITION);
    assert.equal(heldResult.error.uncertain, false);

    const pointer = [...mock.state.collections.get(WS_PACK_SELECTIONS_COLLECTION).values()][0].data;
    const target = mock.state.collections.get(WS_PACKS_COLLECTION).get(recordKeyFor("education", "0.3.0")).data;
    if (retireFirst) {
      assert.equal(pointer.version, "0.3.0", "the select won: the pointer moved");
      assert.equal(target.status, "available", "the select won: the retirement rolled back");
    } else {
      assert.equal(pointer.version, "0.2.0", "the retire won: the pointer stayed put");
      assert.equal(target.status, "retired", "the retire won: the target is retired");
    }
    await mock.close();
  }
});

test("an incomplete, missing or retired target is refused without any write", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  seedInstalledPack(mock, { packId: "education", version: "0.2.0", status: "installing", contentHash: CONTENT_A });
  seedInstalledPack(mock, { packId: "education", version: "0.3.0", status: "retired", contentHash: CONTENT_B });

  for (const [version, contentHash] of [["0.2.0", CONTENT_A], ["0.3.0", CONTENT_B], ["9.9.9", CONTENT_A]]) {
    const checkpoint = mock.requests.length;
    await assert.rejects(
      selectPackVersion({ packId: "education", version, contentHash, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
      error => error.code === CODE.SELECTION_TARGET_INVALID && error.uncertain !== true,
      `selecting ${version} must be refused`,
    );
    assert.ok(mock.requests.slice(checkpoint).every(request => request.method === "GET" ||
      request.method === "PUT" && request.path.startsWith("/v2/data-schemas/") ||
      request.path.endsWith("/openid-connect/token")),
      `the refusal of ${version} must have made no effect beyond desired-state replays`);
  }
  assert.equal(mock.state.collections.has(WS_PACK_SELECTIONS_COLLECTION), false,
    "a refused select must not even bootstrap the selection record");

  await assert.rejects(
    retirePackVersion({ packId: "education", version: "0.2.0", config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.SELECTION_TARGET_INVALID && error.uncertain !== true,
    "an incomplete install is never retired",
  );
  await assert.rejects(
    retirePackVersion({ packId: "education", version: "9.9.9", config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.SELECTION_TARGET_INVALID && error.uncertain !== true,
  );
});

test("retiring the currently selected version is refused without any write", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A });
  await selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });

  const checkpoint = mock.requests.length;
  await assert.rejects(
    retirePackVersion({ packId: "education", version: "0.2.0", config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.RETIRE_SELECTED && error.uncertain !== true && /active selection/.test(error.message),
  );
  assert.ok(mock.requests.slice(checkpoint).every(request => request.path !== "/v2/data:batch"),
    "the refusal must happen before any batch");
  assert.ok(mock.requests.slice(checkpoint).every(request => !request.path.startsWith("/v1/directory/") &&
    !request.path.startsWith("/v1/workflows/") && request.method !== "DELETE"),
    "an active-target refusal leaves Directory and engine resources untouched");
  assert.equal([...mock.state.collections.get(WS_PACKS_COLLECTION).values()][0].data.status, "available");
});

test("a non-console-admin user, a foreign-tenant operator or a foreign backend mutates nothing (fail closed)", async t => {
  const viewer = await startMockCore({
    operatorIdentity: { subject: "ops", tenantId: TENANT, consoleRole: "viewer", roles: ["core-reader"] },
  });
  t.after(() => viewer.close());
  seedInstalledPack(viewer, { packId: "education", version: "0.2.0", contentHash: CONTENT_A });
  for (const run of [
    () => selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(viewer), attempts: 3, delayMs: 1 }),
    () => retirePackVersion({ packId: "education", version: "0.2.0", config: lifecycleConfig(viewer), attempts: 3, delayMs: 1 }),
  ]) {
    await assert.rejects(run, error => error.code === CODE.OPERATOR_IDENTITY_REJECTED && error.uncertain !== true);
    assert.equal(viewer.requests.filter(request => request.method === "PUT" || request.method === "POST" && !request.path.endsWith("/openid-connect/token")).length, 0,
      "no schema, record or batch write may happen before the operator is verified");
    assert.ok(viewer.requests.every(request => !request.path.startsWith("/v1/directory/") && !request.path.startsWith("/v1/workflows/")),
      "an unauthorized command leaves Directory and engine resources untouched");
  }

  const foreign = await startMockCore({ operatorToken: "another-operator-token" });
  t.after(() => foreign.close());
  seedInstalledPack(foreign, { packId: "education", version: "0.2.0", contentHash: CONTENT_A });
  await assert.rejects(
    selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(foreign), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.OPERATOR_IDENTITY_REJECTED && error.uncertain !== true,
    "an operator of another tenant is rejected",
  );
  assert.equal(foreign.requests.filter(request => request.method === "PUT" || request.method === "POST" && !request.path.endsWith("/openid-connect/token")).length, 0);

  const foreignBackend = await startMockCore({
    appIdentity: { subject: "pack-backend", tenantId: "tenant-khac", roles: ["core-writer"] },
  });
  t.after(() => foreignBackend.close());
  seedInstalledPack(foreignBackend, { packId: "education", version: "0.2.0", contentHash: CONTENT_A });
  await assert.rejects(
    retirePackVersion({ packId: "education", version: "0.2.0", config: lifecycleConfig(foreignBackend), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.BACKEND_IDENTITY_REJECTED && error.uncertain !== true,
    "a backend application of another tenant owns no records",
  );
  assert.equal(foreignBackend.requests.filter(request => request.method === "PUT" || request.method === "POST" && !request.path.endsWith("/openid-connect/token")).length, 0);
});

test("retirement marks only the target version retired and keeps every deployed resource for existing cases", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  const target = seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A, definitions: DEFINITIONS, directory: DIRECTORY });
  seedInstalledPack(mock, { packId: "education", version: "0.3.0", contentHash: CONTENT_B, definitions: DEFINITIONS, directory: DIRECTORY });
  await selectPackVersion({ packId: "education", version: "0.3.0", contentHash: CONTENT_B, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });

  const outcome = await retirePackVersion({ packId: "education", version: "0.2.0", config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(outcome.outcome, "retired");

  const record = mock.state.collections.get(WS_PACKS_COLLECTION).get(recordKeyFor("education", "0.2.0"));
  assert.deepEqual(record.data, { ...target.data, status: "retired" },
    "only the status changes: definitions, Directory receipts and the content hash stay intact");
  assert.ok(mock.requests.every(request => request.method !== "DELETE"),
    "retirement deletes nothing");
  assert.ok(mock.requests.every(request => !request.path.startsWith("/v1/directory/") && !request.path.startsWith("/v1/workflows/")),
    "retirement never touches Directory or the BPMN engine");
  const batch = mock.requests.findLast(request => request.path === "/v2/data:batch");
  assert.deepEqual(batch.body.operations.map(operation => operation.op), ["replace", "replace"],
    "the retire batch only replaces the pointer (pinned same-data) and the target");
  assert.deepEqual(batch.body.operations[0].data, { key: SELECTION_RECORD_KEY, packId: "education", version: "0.3.0", contentHash: CONTENT_B },
    "the pointer pin is a same-data replacement");
});

test("an uncertain batch outcome stops the run and the rerun replays under the same derived key", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A });

  mock.state.faults.batchUnavailable = 1;
  await assert.rejects(
    selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 1, delayMs: 1 }),
    error => error.code === CODE.PENDING_NOT_SETTLED && error.uncertain === true,
  );
  assert.equal([...mock.state.collections.get(WS_PACKS_COLLECTION).values()][0].data.status, "available",
    "an uncertain outcome never leaves a half-applied batch");

  const outcome = await selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 });
  assert.equal(outcome.outcome, "selected");
  const batches = mock.requests.filter(request => request.path === "/v2/data:batch");
  assert.equal(batches.length, 2);
  assert.equal(batches[0].idempotencyKey, batches[1].idempotencyKey,
    "the rerun must reuse the exact same derived key, never a fresh one");
  assert.deepEqual(batches[1].body, batches[0].body, "the rerun replays the identical logical request");
});

test("a request key reused with a different body is reported and never resolved with a fresh key", async t => {
  const mock = await startMockCore();
  t.after(() => mock.close());
  seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: CONTENT_A });

  mock.state.faults.batchReplyConflict = 1;
  await assert.rejects(
    selectPackVersion({ packId: "education", version: "0.2.0", contentHash: CONTENT_A, config: lifecycleConfig(mock), attempts: 3, delayMs: 1 }),
    error => error.code === CODE.RECORD_IDEMPOTENCY_CONFLICT && error.uncertain !== true,
  );
  assert.equal(mock.requests.filter(request => request.path === "/v2/data:batch").length, 1,
    "the run must not pick a fresh key and try again");
  assert.equal([...mock.state.collections.get(WS_PACKS_COLLECTION).values()][0].data.status, "available");
});

test("the CLI selects, lists, switches and retires through the operator surface", async t => {
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

  const mounted = await withPackCopy(async pack => {
    const manifest = JSON.parse(await readFile(path.join(pack, "pack.json"), "utf8"));
    manifest.version = "0.3.0";
    await writeFile(path.join(pack, "pack.json"), JSON.stringify(manifest, null, 2));
    return pack;
  });
  const read03 = await readPack(mounted.pack);
  const read02 = await readPack(EDUCATION);
  seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: packContentHash(read02.pack), definitions: DEFINITIONS, directory: DIRECTORY });
  seedInstalledPack(mock, { packId: "education", version: "0.3.0", contentHash: packContentHash(read03.pack), definitions: DEFINITIONS, directory: DIRECTORY });

  const initial = await run(["--list"]);
  assert.equal(initial.status, 0, `expected exit 0, got ${initial.status} with stderr ${initial.stderr}`);
  assert.equal(JSON.parse(initial.stdout).selection, null, "a fresh stack lists no selection");

  const selected = await run([mounted.pack, "--select"]);
  assert.equal(selected.status, 0, `expected exit 0, got ${selected.status} with stderr ${selected.stderr}`);
  const selection = JSON.parse(selected.stdout);
  assert.equal(selection.ok, true);
  assert.equal(selection.outcome, "selected");
  assert.deepEqual(selection.selection, { packId: "education", version: "0.3.0", contentHash: packContentHash(read03.pack) });

  const listed = await run(["--list"]);
  const listing = JSON.parse(listed.stdout);
  assert.equal(listing.selection.version, "0.3.0");
  assert.deepEqual(listing.packs.map(entry => [entry.version, entry.selected, entry.status]),
    [["0.3.0", true, "available"], ["0.2.0", false, "available"]]);

  const refused = await run(["--retire", "education", "0.3.0"]);
  assert.equal(refused.status, 1, "the active version is refused for retirement");
  assert.equal(errorPayloadOf(refused.stderr).error.code, CODE.RETIRE_SELECTED);

  const switched = await run([EDUCATION, "--select"]);
  assert.equal(switched.status, 0, `expected exit 0, got ${switched.status} with stderr ${switched.stderr}`);
  assert.equal(JSON.parse(switched.stdout).selection.version, "0.2.0");

  const retired = await run(["--retire", "education", "0.3.0"]);
  assert.equal(retired.status, 0, `expected exit 0, got ${retired.status} with stderr ${retired.stderr}`);
  const retirement = JSON.parse(retired.stdout);
  assert.equal(retirement.ok, true);
  assert.equal(retirement.outcome, "retired");

  const after = await run(["--list"]);
  const afterListing = JSON.parse(after.stdout);
  assert.deepEqual(afterListing.packs.map(entry => [entry.version, entry.selected, entry.status]),
    [["0.3.0", false, "retired"], ["0.2.0", true, "available"]]);

  const replay = await run(["--retire", "education", "0.3.0"]);
  assert.equal(replay.status, 0);
  assert.equal(JSON.parse(replay.stdout).outcome, "replayed");

  const missing = await run(["--retire", "education", "9.9.9"]);
  assert.equal(missing.status, 1);
  assert.equal(errorPayloadOf(missing.stderr).error.code, CODE.SELECTION_TARGET_INVALID);

  const noConfig = await run([mounted.pack, "--select"], { env: { ...env, JUNCTURA_URL: "", JUNCTURA_TENANT: "" } });
  assert.equal(noConfig.status, 3, "missing configuration is a refusal, distinct from invalid input");
  assert.equal(noConfig.stdout, "");
  assert.match(noConfig.stderr, /Nothing was changed/);

  assert.equal((await run(["--select"])).status, 2, "--select expects a pack directory");
  assert.equal((await run(["--retire", "education"])).status, 2, "--retire expects a pack id and a version");
  assert.equal((await run(["--retire", "education", "khong-phai-phan-ban"])).status, 2, "a non-orderable version is a usage error");
  assert.equal((await run(["--select", EDUCATION, "--retire", "education", "0.2.0"])).status, 2, "--select and --retire cannot combine");
  assert.equal((await run([EDUCATION, "--select", "--dry-run"])).status, 2, "--select cannot combine with --dry-run");
  await mounted.cleanup();
});

test("the CLI select verifies the mounted pack against the durable record and refuses changed content", async t => {
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
  const run = args => new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("close", status => resolve({ status, stdout, stderr }));
  });

  const read02 = await readPack(EDUCATION);
  seedInstalledPack(mock, { packId: "education", version: "0.2.0", contentHash: packContentHash(read02.pack), definitions: DEFINITIONS, directory: DIRECTORY });

  await withPackCopy(async pack => {
    const manifest = JSON.parse(await readFile(path.join(pack, "pack.json"), "utf8"));
    manifest.name = "Gói Giáo dục (tài nguyên gắn khác nội dung)";
    await writeFile(path.join(pack, "pack.json"), JSON.stringify(manifest, null, 2));
    const { status, stdout, stderr } = await run([pack, "--select"]);
    assert.equal(status, 1);
    assert.equal(stdout, "");
    assert.equal(errorPayloadOf(stderr).error.code, CODE.VERSION_CONTENT_MISMATCH,
      "the mounted pack must match the recorded content of the version being selected");
    assert.equal(mock.requests.filter(request => request.path === "/v2/data:batch").length, 0,
      "a content mismatch must never reach the atomic swap");
  });
  const intact = await run([EDUCATION, "--select"]);
  assert.equal(intact.status, 0, `expected exit 0, got ${intact.status} with stderr ${intact.stderr}`);
  assert.equal(JSON.parse(intact.stdout).selection.version, "0.2.0");
});

async function withPackCopy(mutate = async () => {}) {
  const base = await mkdtemp(path.join(tmpdir(), "junctura-selection-"));
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
