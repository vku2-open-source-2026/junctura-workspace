// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Tests of the Workspace backend. Every route runs against a real
// HTTP server on the loopback interface with fake dependencies (verifyToken,
// junctura, fetchExecution, fetchIdentity, now), so nothing here touches the network
// beyond 127.0.0.1. The JWT verifier is exercised with a freshly generated
// RSA key, as the real one would; staff identity goes through the real
// `createStaffFor` resolver over a fake `GET /v1/identity`.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { createApp } from "../app.mjs";
import { AuthError, createVerifier } from "../jwt.mjs";
import { BOARD_GROUP, createStaffFor, isVerifiedIdentity } from "../staff.mjs";

const NOW = () => new Date("2026-11-19T01:02:03.000Z");
const STAMP = "2026-11-19T01:02:03.000Z";
const EXEC = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0";
const OTHER = "ffffffff-1111-4222-8333-444444444444";
const TENANT = "junctura";
const ADMIN = { username: "quantri.soyte", displayName: "Quản trị Sở Y tế", facility: "so-y-te" };
const CLINIC = { username: "ysi.tramyte", displayName: "Y sĩ Lê Thi Hoa", facility: "tram-y-te" };
const AUTH = { authorization: "Bearer good" };

let serial = 0;
const uuid = () => `aaaaaaaa-0000-4000-8000-${String(++serial).padStart(12, "0")}`;

/** A fake of the SDK client: /v2/data listing with limit/order/cursor plus records and objects. */
function fakeJunctura({ lists = {} } = {}) {
  const records = new Map(), objects = new Map(), calls = [];
  const fail = (status, code) => {
    const error = new Error(`Junctura request failed (${status}, ${code})`);
    error.name = "JuncturaError";
    error.status = status;
    error.code = code;
    throw error;
  };
  return {
    calls, records, objects,
    async request(path) {
      calls.push(path);
      const [base, query = ""] = path.split("?");
      const match = /^\/v2\/data\/([a-z-]+)$/.exec(base);
      if (!match) fail(500, "unexpected_path");
      const params = new URLSearchParams(query);
      const limit = Number(params.get("limit") ?? 100);
      const order = params.get("order") ?? "asc";
      const offset = params.has("cursor") ? Number(Buffer.from(params.get("cursor"), "base64url").toString("utf8")) : 0;
      const all = lists[match[1]] ?? [];
      const ordered = order === "desc" ? [...all].reverse() : all;
      const page = ordered.slice(offset, offset + limit);
      const next = offset + page.length;
      return Response.json({ items: page, nextCursor: next < ordered.length ? Buffer.from(String(next)).toString("base64url") : null });
    },
    async createRecord(collection, data) {
      calls.push(`createRecord ${collection}`);
      const id = uuid();
      records.set(`${collection}/${id}`, { id, data });
      return { id, data };
    },
    async getRecord(collection, id) {
      calls.push(`getRecord ${collection}/${id}`);
      const record = records.get(`${collection}/${id}`);
      if (!record) fail(404, "not_found");
      return record;
    },
    async putObject(id, bytes) {
      calls.push(`putObject ${id}`);
      objects.set(id, bytes);
      return { id, size: bytes.length };
    },
    async getObject(id) {
      calls.push(`getObject ${id}`);
      return objects.get(id);
    },
  };
}

/** A `VerifiedIdentity` body as the pinned Foundation contract would answer (`preferredUsername: null` omits it). */
function identityBody({ tenant = TENANT, units = ["so-y-te"], groups, preferredUsername = "Quản trị Sở Y tế", subject = "login-42" } = {}) {
  return {
    subject,
    tenantId: tenant,
    roles: ["core-reader"],
    ...(preferredUsername ? { preferredUsername } : {}),
    units,
    unitPaths: units.map(id => ({ id, path: `/${tenant}/${id}` })),
    groups: groups ?? (units.includes("so-y-te") ? [`/so-y-te/${BOARD_GROUP}`] : []),
  };
}

function deps({ staff = ADMIN, units, groups, tenant = TENANT, preferredUsername, subject = "login-42", tokenSub, identityStatus = 200, identityShape, identityDown = false, badToken = false, execution = 200, ...rest } = {}) {
  const junctura = fakeJunctura(rest);
  const body = identityShape === undefined
    ? identityBody({ tenant, units: units ?? [staff.facility ?? "so-y-te"], groups, preferredUsername, subject })
    : identityShape;
  return {
    junctura,
    calls: junctura.calls,
    records: junctura.records,
    objects: junctura.objects,
    verifyToken: async token => {
      if (badToken || token !== "good") throw new AuthError("nope");
      return {
        ...(tokenSub === null ? {} : { sub: tokenSub ?? subject }),
        preferred_username: staff.username,
        azp: "health-portal-web",
      };
    },
    fetchExecution: async () => ({ ok: execution === 200, status: execution === 200 ? 200 : execution }),
    fetchIdentity: async token => {
      if (token !== "good") return { status: 401 };
      if (identityDown) return { status: 0 };
      if (identityStatus !== 200) return { status: identityStatus };
      return { status: 200, body };
    },
    now: NOW,
  };
}

/** The app under test: the real Directory resolver over the fake identity answer. */
function appOf(provided) {
  return createApp({ ...provided, staffFor: createStaffFor({ expectedTenant: TENANT, fetchIdentity: provided.fetchIdentity }) });
}

async function withServer(provided, run) {
  const server = createServer(appOf(provided));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    return await run(base, provided);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

const post = (base, path, body, headers = AUTH) => fetch(new URL(path, base), { method: "POST", headers, body });
const get = (base, path, headers = AUTH) => fetch(new URL(path, base), { headers });

test("staff identity is the caller's verified Directory identity, unit by unit", async () => {
  const seen = [];
  const staffFor = createStaffFor({
    expectedTenant: TENANT,
    fetchIdentity: async token => {
      seen.push(token);
      return { status: 200, body: identityBody({ units: ["tram-y-te"], preferredUsername: "Y sĩ Lê Thị Hoa" }) };
    },
  });
  const outcome = await staffFor("tok", { sub: "login-42", preferred_username: "ysi.tramyte" }, null);
  assert.ok(outcome.ok);
  assert.deepEqual(outcome.staff, { username: "ysi.tramyte", displayName: "Y sĩ Lê Thị Hoa", facility: "tram-y-te", groups: [], canPublish: false });
  assert.deepEqual(seen, ["tok"], "the caller's own token, nothing else");
  const coordinator = createStaffFor({ expectedTenant: TENANT, fetchIdentity: async () => ({ status: 200, body: identityBody() }) });
  assert.ok((await coordinator("t", { sub: "login-42", preferred_username: "quantri.soyte" }, null)).staff.canPublish, "the verified board group carries the publication right");
  assert.throws(() => createStaffFor({ fetchIdentity: async () => ({ status: 200 }) }), TypeError, "the expected tenant is required");
  assert.throws(() => createStaffFor({ expectedTenant: TENANT }), TypeError, "the identity fetch is required");
});

test("the verified local sub must be nonempty and match the response subject exactly", async () => {
  const staffFor = createStaffFor({ expectedTenant: TENANT, fetchIdentity: async () => ({ status: 200, body: identityBody() }) });
  assert.deepEqual(await staffFor("t", { preferred_username: "quantri.soyte" }, null), { ok: false, status: 403, code: "forbidden" }, "no sub, no membership");
  assert.deepEqual(await staffFor("t", { sub: "", preferred_username: "quantri.soyte" }, null), { ok: false, status: 403, code: "forbidden" }, "an empty sub is no sub");
  assert.deepEqual(await staffFor("t", { sub: "different-user", preferred_username: "another" }, null), { ok: false, status: 403, code: "forbidden" }, "a token of another subject is not the verified identity, whatever the username says");
  assert.ok((await staffFor("t", { sub: "login-42", preferred_username: "quantri.soyte" }, null)).ok, "the exact subject match is accepted");
});

test("a caller of another tenant is refused before any facility is chosen", async () => {
  const staffFor = createStaffFor({
    expectedTenant: TENANT,
    fetchIdentity: async () => ({ status: 200, body: identityBody({ tenant: "tenant-other" }) }),
  });
  const outcome = await staffFor("t", { sub: "login-42", preferred_username: "quantri.soyte" }, null);
  assert.deepEqual(outcome, { ok: false, status: 403, code: "forbidden" });
});

test("a malformed VerifiedIdentity answer is unusable, not a refusal of the caller", () => {
  const good = identityBody();
  const broken = {
    "not an object": null,
    "missing subject": { ...good, subject: undefined },
    "empty tenant": { ...good, tenantId: "" },
    "roles without core-reader": { ...good, roles: ["core-writer"] },
    "units not an array": { ...good, units: "so-y-te" },
    "unit of the wrong shape": { ...good, units: ["So_YTe"] },
    "unitPaths missing": { ...good, unitPaths: undefined },
    "unitPath without path": { ...good, unitPaths: [{ id: "so-y-te" }] },
    "path of another tenant": { ...good, unitPaths: [{ id: "so-y-te", path: "/tenant-other/so-y-te" }] },
    "path of another unit": { ...good, unitPaths: [{ id: "so-y-te", path: "/junctura/benh-vien" }] },
    "path of an unadvertised unit": { ...good, unitPaths: [{ id: "benh-vien", path: "/junctura/benh-vien" }] },
    "unit without its path entry": { ...good, units: ["so-y-te", "benh-vien"] },
    "duplicate unitPath ids": { ...good, unitPaths: [{ id: "so-y-te", path: "/junctura/so-y-te" }, { id: "so-y-te", path: "/junctura/benh-vien" }] },
    "groups missing": { ...good, groups: undefined },
    "group of the wrong shape": { ...good, groups: ["so-y-te/ban-tin"] },
    "preferredUsername too long": { ...good, preferredUsername: "x".repeat(256) },
    "an array": [good],
  };
  for (const [what, body] of Object.entries(broken)) {
    assert.equal(isVerifiedIdentity(body), false, what);
  }
  assert.ok(isVerifiedIdentity(good));
  assert.ok(isVerifiedIdentity({ ...good, preferredUsername: undefined }), "preferredUsername stays optional");
});

test("upstream answers are separated: authorization is passed through, the rest is unavailable", async () => {
  const cases = [
    [401, { ok: false, status: 401, code: "unauthorized" }],
    [403, { ok: false, status: 403, code: "forbidden" }],
    [404, { ok: false, status: 403, code: "forbidden" }],
    [400, { ok: false, status: 503, code: "junctura_unavailable" }],
    [500, { ok: false, status: 503, code: "junctura_unavailable" }],
    [0, { ok: false, status: 503, code: "junctura_unavailable" }],
    [200, { ok: false, status: 503, code: "junctura_unavailable" }, { status: 200, body: "không phải json" }],
  ];
  for (const [status, expected, answer] of cases) {
    const staffFor = createStaffFor({ expectedTenant: TENANT, fetchIdentity: async () => answer ?? { status } });
    assert.deepEqual(await staffFor("t", { sub: "login-42", preferred_username: "quantri.soyte" }, null), expected, `upstream ${status}`);
  }
});

test("several verified units fail closed unless the caller names one the membership permits", async () => {
  const units = ["tram-y-te", "benh-vien", "so-y-te"];
  const groups = [`/so-y-te/${BOARD_GROUP}`];
  const staffFor = createStaffFor({
    expectedTenant: TENANT,
    fetchIdentity: async () => ({ status: 200, body: identityBody({ units, groups, preferredUsername: undefined }) }),
  });
  assert.deepEqual(await staffFor("t", { sub: "login-42", preferred_username: "ysi" }, null), { ok: false, status: 403, code: "forbidden" }, "several units without an explicit choice fail closed, whatever the order");
  assert.deepEqual((await staffFor("t", { sub: "login-42", preferred_username: "ysi" }, "benh-vien")).staff, { username: "ysi", displayName: "Quản trị Sở Y tế", facility: "benh-vien", groups: [`/so-y-te/${BOARD_GROUP}`], canPublish: false }, "an explicit unit of the verified membership is honoured");
  assert.deepEqual((await staffFor("t", { sub: "login-42", preferred_username: "ysi" }, "so-y-te")).staff.canPublish, true, "the group right travels with the selected unit");
  assert.deepEqual(await staffFor("t", { sub: "login-42", preferred_username: "ysi" }, "nha-thuoc"), { ok: false, status: 403, code: "forbidden" }, "a unit outside the verified membership is refused");
  assert.deepEqual(await staffFor("t", { sub: "login-42", preferred_username: "ysi" }, "So_YTe"), { ok: false, status: 400, code: "invalid_input" }, "a malformed unit name is bad input");
  // No fixed unit list is baked in: a verified unit of the tenant is a portal
  // unit, whatever sector it belongs to. A deployment that wants a restriction
  // passes the accepted units explicitly.
  const neutral = createStaffFor({
    expectedTenant: TENANT,
    fetchIdentity: async () => ({ status: 200, body: identityBody({ units: ["truong"], groups: [] }) }),
  });
  assert.ok((await neutral("t", { sub: "login-42", preferred_username: "nv-truong" }, null)).ok, "a staff member of any verified unit signs in with their own membership");
  const restricted = createStaffFor({
    expectedTenant: TENANT,
    facilities: new Set(["truong"]),
    fetchIdentity: async () => ({ status: 200, body: identityBody({ units: ["hoi-dong"] }) }),
  });
  assert.deepEqual(await restricted("t", { sub: "login-42", preferred_username: "ysi" }), { ok: false, status: 403, code: "forbidden" }, "a unit outside an explicitly configured facilities set is refused");
});

test("GET /api/me answers the staff identity of the token, groups included", async () => {
  await withServer(deps(), async base => {
    const response = await get(base, "/api/me");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      username: ADMIN.username,
      displayName: ADMIN.displayName,
      facility: "so-y-te",
      groups: [`/so-y-te/${BOARD_GROUP}`],
      canPublish: true,
    });
  });
  await withServer(deps({ units: ["tram-y-te", "so-y-te"], groups: [], preferredUsername: null }), async base => {
    const response = await get(base, "/api/me?unit=tram-y-te");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { username: ADMIN.username, displayName: ADMIN.username, facility: "tram-y-te", groups: [], canPublish: false });
    assert.equal((await get(base, "/api/me")).status, 403, "several units without an explicit choice fail closed");
    assert.equal((await get(base, "/api/me?unit=benh-vien")).status, 403, "selection outside the verified membership");
    assert.equal((await get(base, "/api/me?unit=Ban_Dieu_Hanh")).status, 400);
  });
});

test("GET /api/me refuses a token whose sub does not match the verified subject", async () => {
  await withServer(deps({ subject: "core-user" }), async base => {
    assert.equal((await get(base, "/api/me")).status, 200, "the exact match of sub and subject is accepted");
  });
  await withServer(deps({ subject: "core-user", tokenSub: "different-user" }), async base => {
    const response = await get(base, "/api/me");
    assert.equal(response.status, 403, "the review scenario: a locally verified token of another sub is not this identity, preferred_username notwithstanding");
    assert.equal((await response.json()).error, "forbidden");
  });
  await withServer(deps({ tokenSub: null }), async base => {
    const response = await get(base, "/api/me");
    assert.equal(response.status, 403, "a token without a sub grants nothing");
    assert.equal((await response.json()).error, "forbidden");
  });
  await withServer(deps({ tokenSub: "" }), async base => {
    assert.equal((await get(base, "/api/me")).status, 403, "an empty sub grants nothing");
  });
});

test("requests without a token, with a bad token, or from a patient are refused", async () => {
  await withServer(deps(), async base => {
    assert.equal((await get(base, "/api/me", {})).status, 401);
    assert.equal((await get(base, "/api/me", { authorization: "Bearer nope" })).status, 401);
    assert.equal((await get(base, "/api/me", { authorization: "good" })).status, 401, "the scheme must be Bearer");
  });
  await withServer(deps({ staff: { ...ADMIN, username: "benhnhan.an" }, units: [] }), async base => {
    const response = await get(base, "/api/me");
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "forbidden");
  });
});

test("a wrong tenant or an unusable identity answer never opens a route", async () => {
  await withServer(deps({ tenant: "tenant-other" }), async base => {
    const response = await get(base, "/api/me");
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "forbidden");
  });
  await withServer(deps({ identityDown: true }), async base => {
    const response = await get(base, "/api/me");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "junctura_unavailable");
  });
  await withServer(deps({ identityShape: null }), async base => {
    assert.equal((await get(base, "/api/me")).status, 503, "a malformed body is unavailable, not forbidden");
    assert.equal((await get(base, "/api/bang-tin")).status, 503);
  });
  await withServer(deps({
    identityShape: { ...identityBody(), unitPaths: [{ id: "so-y-te", path: "/tenant-other/so-y-te" }] },
  }), async base => {
    assert.equal((await get(base, "/api/me")).status, 503, "a contradictory path pairing is malformed and grants no access");
    assert.equal((await get(base, "/api/bang-tin")).status, 503);
  });
  await withServer(deps({
    identityShape: { ...identityBody(), units: ["so-y-te", "benh-vien"] },
  }), async base => {
    assert.equal((await get(base, "/api/me")).status, 503, "an advertised unit without its path entry is malformed and grants no access");
  });
  await withServer(deps({ identityStatus: 401 }), async base => {
    assert.equal((await get(base, "/api/me")).status, 401);
  });
  await withServer(deps({ identityStatus: 403 }), async base => {
    const response = await get(base, "/api/me");
    assert.equal(response.status, 403);
  });
});

test("GET /api/bang-tin lists at most 20 entries, newest first", async () => {
  const entries = Array.from({ length: 25 }, (_, index) => ({
    id: uuid(), collection: "bang-tin", created_at: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
    data: { title: `Tin ${index}`, body: `Nội dung ${index}`, author: { displayName: "Người", facility: "so-y-te" }, createdAt: `2026-01-${String(index + 1).padStart(2, "0")}T00:00:00Z` },
  }));
  await withServer(deps({ lists: { "bang-tin": entries } }), async (base, provided) => {
    const response = await get(base, "/api/bang-tin");
    assert.equal(response.status, 200);
    const { items } = await response.json();
    assert.equal(items.length, 20);
    assert.equal(items[0].title, "Tin 24", "newest first");
    assert.deepEqual(items[0].author, { displayName: "Người", facility: "so-y-te" });
    assert.deepEqual(provided.calls, ["/v2/data/bang-tin?limit=20&order=desc"], "a single page, descending");
  });
});

test("POST /api/bang-tin stores an entry authored from the token, and only Sở Y tế may write", async () => {
  await withServer(deps(), async (base, provided) => {
    const response = await post(base, "/api/bang-tin", JSON.stringify({ title: "Bảo trì hệ thống", body: "Từ 20h hôm nay.", author: { displayName: "Giả mạo", facility: "tram-y-te" } }), { ...AUTH, "content-type": "application/json" });
    assert.equal(response.status, 201);
    const notice = await response.json();
    assert.deepEqual(notice, { id: notice.id, title: "Bảo trì hệ thống", body: "Từ 20h hôm nay.", author: { displayName: ADMIN.displayName, facility: "so-y-te" }, createdAt: STAMP }, "the author comes from the token, never from the body");
    assert.equal([...provided.records.values()][0].data.author.displayName, ADMIN.displayName);
  });
  await withServer(deps({ staff: CLINIC }), async (base, provided) => {
    const response = await post(base, "/api/bang-tin", JSON.stringify({ title: "x", body: "y" }), { ...AUTH, "content-type": "application/json" });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "forbidden");
    assert.equal(provided.records.size, 0);
  });
});

test("the board write right is the verified group of Sở Y tế, not mere membership", async () => {
  await withServer(deps({ groups: [] }), async (base, provided) => {
    const response = await post(base, "/api/bang-tin", JSON.stringify({ title: "x", body: "y" }), { ...AUTH, "content-type": "application/json" });
    assert.equal(response.status, 403, "a so-y-te member without the board group may not publish");
    assert.equal(provided.records.size, 0);
  });
  await withServer(deps(), async base => {
    assert.equal((await post(base, "/api/bang-tin", JSON.stringify({ title: "x", body: "y" }), { ...AUTH, "content-type": "application/json" })).status, 201);
  });
});

test("POST /api/bang-tin rejects bad input with 400 and wrong content types with 415", async () => {
  await withServer(deps(), async base => {
    const cases = [
      ['{"title":"","body":"x"}', "application/json", 400],
      [`{"title":"${"a".repeat(121)}","body":"x"}`, "application/json", 400],
      ['{"title":"ok","body":""}', "application/json", 400],
      [`{"title":"ok","body":"${"b".repeat(2001)}"}`, "application/json", 400],
      ['{"title":1,"body":"x"}', "application/json", 400],
      ["[1,2]", "application/json", 400],
      ["không phải json", "application/json", 400],
      ['{"title":"ok","body":"x"}', "text/plain", 415],
      ['{"title":"ok","body":"x"}', "", 415],
    ];
    for (const [body, contentType, expected] of cases) {
      const headers = { ...AUTH, ...(contentType ? { "content-type": contentType } : {}) };
      const response = await post(base, "/api/bang-tin", body, headers);
      assert.equal(response.status, expected, `${contentType || "(không có)"}: ${body.slice(0, 40)}`);
    }
  });
});

test("notes are scoped to one execution, oldest first, at most 100, through at most five pages", async () => {
  const notes = Array.from({ length: 700 }, (_, index) => ({
    id: uuid(), collection: "ghi-chu", created_at: `2026-02-01T00:00:00Z`,
    data: index < 30
      ? { executionId: EXEC, text: `Ghi chú ${index}`, author: { displayName: "Y sĩ", facility: "tram-y-te" }, createdAt: `2026-02-01T00:00:00Z` }
      : { executionId: OTHER, text: "khác", author: { displayName: "Y sĩ", facility: "tram-y-te" }, createdAt: "2026-02-02T00:00:00Z" },
  }));
  await withServer(deps({ lists: { "ghi-chu": notes } }), async (base, provided) => {
    const response = await get(base, `/api/ho-so/${EXEC}/ghi-chu`);
    assert.equal(response.status, 200);
    const { items } = await response.json();
    assert.equal(items.length, 30, "all pages are walked until the cap");
    assert.ok(items.every(item => item.executionId === EXEC), "only notes of this record");
    assert.deepEqual(items.map(item => item.text), Array.from({ length: 30 }, (_, index) => `Ghi chú ${index}`), "oldest first");
    const listCalls = provided.calls.filter(call => call.startsWith("/v2/data/ghi-chu"));
    assert.equal(listCalls.length, 5, "at most five pages");
    assert.match(listCalls[0], /limit=100&order=asc$/);
    assert.match(listCalls[1], /cursor=/, "the next page continues from the cursor");
  });
});

test("POST /api/ho-so/{id}/ghi-chu stores a note authored from the token and validates input", async () => {
  await withServer(deps(), async (base, provided) => {
    const response = await post(base, `/api/ho-so/${EXEC}/ghi-chu`, JSON.stringify({ text: "Đã xác minh đơn thuốc." }), { ...AUTH, "content-type": "application/json" });
    assert.equal(response.status, 201);
    const note = await response.json();
    assert.deepEqual(note, { id: note.id, executionId: EXEC, text: "Đã xác minh đơn thuốc.", author: { displayName: ADMIN.displayName, facility: "so-y-te" }, createdAt: STAMP });
    assert.equal([...provided.records.values()][0].data.text, "Đã xác minh đơn thuốc.");
    for (const bad of ['{"text":""}', '{"text":1}', `{"text":"${"x".repeat(1001)}"}`, "{}"]) {
      assert.equal((await post(base, `/api/ho-so/${EXEC}/ghi-chu`, bad, { ...AUTH, "content-type": "application/json" })).status, 400, bad);
    }
    assert.equal((await post(base, `/api/ho-so/${EXEC.toUpperCase()}/ghi-chu`, '{"text":"x"}', { ...AUTH, "content-type": "application/json" })).status, 400, "only lowercase UUIDs");
    assert.equal((await post(base, `/api/ho-so/${EXEC}/ghi-chu`, '{"text":"x"}', { ...AUTH, "content-type": "text/plain" })).status, 415);
  });
  await withServer(deps({ staff: CLINIC }), async base => {
    assert.equal((await post(base, `/api/ho-so/${EXEC}/ghi-chu`, '{"text":"x"}', { ...AUTH, "content-type": "application/json" })).status, 201, "any staff facility may note");
  });
});

test("unknown or unreachable records are 404 and 503, before any write", async () => {
  for (const execution of [404, 0, 500]) {
    await withServer(deps({ execution }), async (base, provided) => {
      const response = await post(base, `/api/ho-so/${EXEC}/ghi-chu`, '{"text":"x"}', { ...AUTH, "content-type": "application/json" });
      assert.equal(response.status, execution === 404 ? 404 : 503);
      assert.equal((await get(base, `/api/ho-so/${EXEC}/tep`)).status, execution === 404 ? 404 : 503);
      assert.equal(provided.records.size, 0, "nothing is written");
    });
  }
});

test("attachments: a valid upload stores the bytes and a metadata record with the original name", async () => {
  await withServer(deps(), async (base, provided) => {
    const bytes = new Uint8Array(2048).fill(0x25);
    const response = await post(base, `/api/ho-so/${EXEC}/tep`, bytes, { ...AUTH, "content-type": "application/pdf", "x-file-name": encodeURIComponent("Kết quả khám.pdf") });
    assert.equal(response.status, 201);
    const meta = await response.json();
    assert.equal(meta.executionId, EXEC);
    assert.equal(meta.name, "Kết quả khám.pdf");
    assert.equal(meta.type, "application/pdf");
    assert.equal(meta.bytes, 2048);
    assert.deepEqual(meta.author, { displayName: ADMIN.displayName, facility: "so-y-te" });
    assert.equal(meta.createdAt, STAMP);
    const [objectId] = [...provided.objects.keys()];
    assert.match(objectId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.deepEqual(provided.objects.get(objectId), Buffer.from(bytes));
    const record = [...provided.records.values()][0];
    assert.equal(record.data.objectId, objectId, "the metadata record points at the stored bytes");
    assert.equal(record.data.name, "Kết quả khám.pdf", "the original name lives only in the metadata");
    const download = await get(base, `/api/tep/${meta.id}`);
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-type"), "application/pdf");
    assert.equal(download.headers.get("content-disposition"), `attachment; filename*=UTF-8''${encodeURIComponent("Kết quả khám.pdf")}`);
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(bytes));
  });
});

test("attachments refuse wrong media types, oversized bodies and bad names", async () => {
  await withServer(deps(), async base => {
    const send = (headers, body = new Uint8Array(16)) => post(base, `/api/ho-so/${EXEC}/tep`, body, headers);
    assert.equal((await send({ ...AUTH, "content-type": "text/plain", "x-file-name": "a.txt" })).status, 415);
    assert.equal((await send({ ...AUTH, "content-type": "image/svg+xml", "x-file-name": "a.svg" })).status, 415);
    assert.equal((await send({ ...AUTH, "content-type": "application/pdf" })).status, 400, "no X-File-Name");
    assert.equal((await send({ ...AUTH, "content-type": "application/pdf", "x-file-name": "a%zz.pdf" })).status, 400, "undecodable name");
    assert.equal((await send({ ...AUTH, "content-type": "application/pdf", "x-file-name": encodeURIComponent("x".repeat(121)) })).status, 400, "name over 120 characters");
    assert.equal((await send({ ...AUTH, "content-type": "application/pdf", "x-file-name": "a.pdf" }, new Uint8Array(0))).status, 400, "empty upload");
    assert.equal((await send({ ...AUTH, "content-type": "image/png", "x-file-name": "big.png" }, new Uint8Array(5 * 1024 * 1024 + 1))).status, 413, "over 5 MiB");
    assert.equal((await send({ ...AUTH, "content-type": "image/jpeg", "x-file-name": "ok.jpg" }, new Uint8Array(5 * 1024 * 1024))).status, 201, "5 MiB exactly is allowed");
  });
});

test("unknown attachments are 404 and malformed ids are 400", async () => {
  await withServer(deps(), async base => {
    const response = await get(base, `/api/tep/${uuid()}`);
    assert.equal(response.status, 404);
    assert.equal((await response.json()).error, "not_found");
    assert.equal((await get(base, "/api/tep/khong-phai-uuid")).status, 400);
  });
});

test("unknown routes are 404 with the error envelope", async () => {
  await withServer(deps(), async base => {
    for (const path of ["/", "/api", "/api/khong-ton-tai", "/api/ho-so", "/v1/identity"]) {
      assert.equal((await get(base, path)).status, 404, path);
    }
    assert.equal((await fetch(new URL("/api/me", base), { method: "DELETE", headers: AUTH })).status, 404);
  });
});

test("an upstream outage answers 503 junctura_unavailable", async () => {
  await withServer(deps(), async (base, provided) => {
    provided.junctura.request = async () => {
      throw new Error("boom");
    };
    const response = await get(base, "/api/bang-tin");
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "junctura_unavailable");
  });
});

test("the JWT verifier checks RS256 signatures, iss, exp and azp = health-portal-web", async () => {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", use: "sig", alg: "RS256" };
  const now = () => Date.parse("2026-11-19T01:00:00.000Z");
  const verifier = createVerifier({
    issuer: "https://junctura.studio/identity/realms/junctura", clientId: "health-portal-web",
    getJson: async url => {
      assert.ok(url.endsWith("/protocol/openid-connect/certs"));
      return { keys: [jwk] };
    },
    now,
  });
  const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = (claims, kid = "k1") => {
    const data = `${encode({ alg: "RS256", typ: "JWT", kid })}.${encode(claims)}`;
    return `${data}.${Buffer.from(sign("RSA-SHA256", Buffer.from(data), privateKey)).toString("base64url")}`;
  };
  const iss = "https://junctura.studio/identity/realms/junctura";
  const claims = { iss, sub: "login-42", exp: now() / 1000 + 300, preferred_username: "quantri.soyte" };
  assert.deepEqual(await verifier(token({ ...claims, azp: "health-portal-web" })), { ...claims, azp: "health-portal-web" });
  await assert.rejects(verifier(token({ ...claims, azp: "other-client" })), /not issued for this application/, "azp must be the portal web client");
  await assert.rejects(verifier(token({ ...claims, iss: "https://other/issuer" })), /wrong issuer/);
  await assert.rejects(verifier(token({ ...claims, exp: now() / 1000 - 60 })), /expired/);
  await assert.rejects(verifier(`${token({ ...claims }).split(".").slice(0, 2).join(".")}.c2lnbg`), /bad signature/);
  await assert.rejects(verifier(token({ ...claims }, "unknown-kid")), /unknown signing key/);
  await assert.rejects(verifier("not-a-token"), /malformed token/);
});

test("the token broker route is opt-in and runs before authentication", async () => {
  const calls = [];
  const provided = deps();
  provided.verifyToken = async () => {
    throw new Error("authentication must not run");
  };
  provided.redeemToken = async req => {
    calls.push({ method: req.method, url: req.url });
    return [418, { error: "teapot" }, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=60" }];
  };

  await withServer(provided, async base => {
    const response = await fetch(new URL("/api/auth/token", base), { method: "POST" });
    assert.equal(response.status, 418);
    assert.equal(response.headers.get("content-type"), "text/plain; charset=utf-8");
    assert.equal(response.headers.get("cache-control"), "public, max-age=60");
    assert.deepEqual(await response.json(), { error: "teapot" });
    assert.deepEqual(calls, [{ method: "POST", url: "/api/auth/token" }]);
  });
});

test("without a configured broker /api/auth/token stays a private route", async () => {
  await withServer(deps(), async base => {
    const response = await fetch(new URL("/api/auth/token", base), { method: "POST" });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  });
});

test("the token broker receives only the exact absolute route", async () => {
  const calls = [];
  const provided = deps();
  provided.redeemToken = async req => {
    calls.push(req.url);
    return [200, { ok: true }];
  };

  await withServer(provided, async base => {
    await fetch(new URL("/api/auth/token?next=1", base), { method: "POST" });
    await fetch(new URL("/api/auth/token/", base), { method: "POST", headers: AUTH });
    assert.deepEqual(calls, ["/api/auth/token?next=1"]);
  });
});
