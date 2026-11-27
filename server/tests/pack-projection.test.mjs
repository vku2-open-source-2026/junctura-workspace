// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Tests of the public pack projection (server/pack-projection.mjs): the
// whitelisted view of an installed pack that `GET /api/pack` serves. Both
// example packs in examples/packs/ must project with their recognizable,
// divergent content; the whitelist must drop anything outside it, and the
// route must stay public while every other route keeps asking for a token.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createApp } from "../app.mjs";
import { readPackProjection, projectPack } from "../pack-projection.mjs";
import { readPack } from "../packs.mjs";

const EXAMPLES = fileURLToPath(new URL("../../examples/packs/", import.meta.url));
const EDUCATION = `${EXAMPLES}education`;
const HEALTH = `${EXAMPLES}health`;

test("the example education pack projects its recognizable record types, groups and SLA", async () => {
  const projection = await readPackProjection(EDUCATION);
  assert.equal(projection.pack.id, "education");
  assert.equal(projection.pack.name, "Gói Giáo dục");
  assert.deepEqual(projection.recordTypes.map(type => type.id), ["chuyen-truong", "cap-ban-sao-hoc-ba"]);
  assert.deepEqual(projection.workflows.map(workflow => workflow.id), ["chuyentruong", "capbansaohocba"]);
  assert.deepEqual(projection.groups.map(group => group.id), ["van-thu", "hoc-vu", "lanh-dao"]);
  assert.deepEqual(projection.unitTypes.map(unitType => unitType.id), ["phong-giao-duc", "truong"]);
  const transfer = projection.workflows[0];
  assert.equal(transfer.open.role, "hoc-vu");
  assert.deepEqual(transfer.open.form.fields.map(field => field.id), ["ho-ten-hoc-sinh", "lop-hien-tai", "truong-chuyen-den"]);
  assert.deepEqual(transfer.steps.map(step => step.deadlineDays), [2, 5, 3]);
  assert.ok(!("units" in projection), "the sample units of the pack never reach the public projection");
  assert.ok(!("bpmn" in transfer), "the raw BPMN source never reaches the public projection");
});

test("the education transfer diagram shows the full flow with both rejection routes labelled from the manifest", async () => {
  const projection = await readPackProjection(EDUCATION);
  const diagram = projection.workflows[0].diagram;
  assert.deepEqual(diagram.path, ["start", "tiep-nhan-ho-so", "quyet-dinh-tiep-nhan", "xet-duyet", "quyet-dinh-xet-duyet", "thong-bao-ket-qua", "end"]);
  assert.deepEqual(diagram.nodes.map(node => node.kind), ["start", "task", "gateway", "task", "gateway", "task", "end", "end", "end"]);
  assert.deepEqual(diagram.nodes.find(node => node.id === "tiep-nhan-ho-so").groups, ["van-thu"]);
  const intake = diagram.edges.filter(edge => edge.from === "quyet-dinh-tiep-nhan");
  assert.deepEqual(intake.map(edge => edge.to), ["xet-duyet", "end-tu-choi-tiep-nhan"], "both gateway outcomes stay in the diagram");
  assert.deepEqual(intake.map(edge => edge.label), ["Tiếp nhận hồ sơ", "Từ chối tiếp nhận"], "the user-facing decision labels of the manifest");
  const review = diagram.edges.filter(edge => edge.from === "quyet-dinh-xet-duyet");
  assert.deepEqual(review.map(edge => edge.label), ["Chấp nhận chuyển trường", "Không chấp nhận"]);
  assert.ok(!JSON.stringify(projection).includes("decision =="), "the internal condition expressions never leave the server");
  assert.ok(!JSON.stringify(projection).includes("Hạn xử lý"), "BPMN documentation notes never leave the server");
});

test("the health diagram diverges: a linear flow with unlabelled edges and no gateways", async () => {
  const projection = await readPackProjection(HEALTH);
  const diagram = projection.workflows[0].diagram;
  assert.deepEqual(diagram.path, ["start", "tiep-nhan-benh-nhan", "kham-va-chi-dinh", "phan-hoi-ket-qua", "end"]);
  assert.deepEqual(diagram.nodes.map(node => node.kind), ["start", "task", "task", "task", "end"]);
  assert.deepEqual(diagram.nodes.find(node => node.id === "tiep-nhan-benh-nhan").groups, ["y-ta"]);
  assert.ok(diagram.edges.every(edge => edge.label == null), "no gateway, no branch labels");
});

test("the example health pack projects its own divergent content from the same shape", async () => {
  const projection = await readPackProjection(HEALTH);
  assert.equal(projection.pack.id, "health");
  assert.equal(projection.pack.name, "Gói Y tế");
  assert.deepEqual(projection.recordTypes.map(type => type.id), ["chuyen-tuyen", "thanh-toan"]);
  assert.deepEqual(projection.workflows.map(workflow => workflow.id), ["chuyen-tuyen", "thanh-toan"]);
  assert.deepEqual(projection.groups.map(group => group.id), ["y-ta", "bac-si", "tai-chinh", "lanh-dao"]);
  const payment = projection.workflows[1];
  assert.deepEqual(payment.steps.map(step => step.deadlineDays), [2, 5]);
  assert.deepEqual(payment.steps[1].decisions.map(decision => decision.outcome), ["approve", "reject", "request-info"]);
});

test("the projection whitelist drops every field outside it", () => {
  const projection = projectPack({
    manifest: {
      id: "demo", name: "Demo", version: "0.1.0", language: "vi", formatVersion: 1,
      internalNotes: "riêng tư", unitsFile: "units.json",
      groups: [{ id: "g1", name: "Nhóm", description: "nội bộ" }],
      unitTypes: [{ id: "u1", name: "Đơn vị", secret: "giá trị" }],
      recordTypes: [{ id: "r1", name: "Loại hồ sơ", internalRef: "x" }],
      workflows: [{
        id: "w1", name: "Quy trình", recordType: "r1", internalPolicy: "không công khai",
        senderUnitTypes: ["u1"], receiverUnitTypes: ["u1"], senderGroups: ["g1"], receiverGroups: ["g1"],
        open: { role: "g1", form: { fields: [{ id: "f1", label: "Trường", type: "text", required: true, hint: "nội bộ" }] } },
        steps: [{
          id: "s1", name: "Bước", role: "g1", unitTypes: ["u1"], deadlineDays: 3,
          form: { fields: [{ id: "f2", label: "Chọn", type: "select", options: ["A", "B"], defaultValue: "A" }] },
          decisions: [{ id: "d1", label: "Đồng ý", outcome: "approve", internalWeight: 2 }],
        }],
      }],
    },
    workflows: [{ id: "w1", bpmn: "w1", processId: "w1", userTaskIds: ["s1"], xml: "<definitions/>" }],
  });
  assert.deepEqual(projection.workflows[0].diagram, { nodes: [], edges: [], path: [] }, "an unparseable diagram degrades to empty, never an error");
  assert.deepEqual(projection, {
    pack: { id: "demo", name: "Demo", version: "0.1.0", language: "vi" },
    groups: [{ id: "g1", name: "Nhóm" }],
    unitTypes: [{ id: "u1", name: "Đơn vị" }],
    recordTypes: [{ id: "r1", name: "Loại hồ sơ" }],
    workflows: [{
      id: "w1", name: "Quy trình", recordType: "r1",
      senderUnitTypes: ["u1"], receiverUnitTypes: ["u1"], senderGroups: ["g1"], receiverGroups: ["g1"],
      open: { role: "g1", form: { fields: [{ id: "f1", label: "Trường", type: "text", required: true }] } },
      steps: [{
        id: "s1", name: "Bước", role: "g1", unitTypes: ["u1"], deadlineDays: 3,
        form: { fields: [{ id: "f2", label: "Chọn", type: "select", options: ["A", "B"] }] },
        decisions: [{ id: "d1", label: "Đồng ý", outcome: "approve" }],
      }],
      diagram: { nodes: [], edges: [], path: [] },
    }],
  });
});

test("readPackProjection reports an unusable pack instead of inventing one", async () => {
  await assert.rejects(() => readPackProjection(`${EXAMPLES}khong-ton-tai`), error => {
    assert.match(error.message, /PACK_DIR_UNREADABLE/);
    return true;
  });
});

test("GET /api/pack is the one public route; the rest still requires a token", async () => {
  const projection = await readPackProjection(EDUCATION);
  const app = createApp({
    verifyToken: async () => { throw new Error("không bao giờ được gọi cho /api/pack"); },
    junctura: {},
    fetchExecution: async () => ({ ok: false, status: 0 }),
    staffFor: async () => ({ ok: false, status: 401, code: "unauthorized" }),
    packProjection: projection,
  });
  const server = createServer(app);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(new URL("/api/pack", base));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), projection);
    assert.equal((await fetch(new URL("/api/pack", base), { method: "POST" })).status, 404, "only GET is public");
    assert.equal((await fetch(new URL("/api/bang-tin", base))).status, 401, "user data stays behind the token");
    assert.equal((await fetch(new URL("/api/me", base))).status, 401);
    assert.equal((await fetch(new URL("/api/pack/khac", base))).status, 401, "a longer path is not the public pack route");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
