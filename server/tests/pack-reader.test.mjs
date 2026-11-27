// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Contract tests of the local pack reader preflight (server/packs.mjs, docs/PACK_FORMAT.md).
// Both fixtures under examples/packs/ must read unchanged; every rejection the
// pack format documents gets a focused case. Negative cases run on throwaway
// copies in the OS temp dir — the reader itself never writes anywhere.
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PackReadErrorCode, readPack } from "../packs.mjs";

const EXAMPLES = fileURLToPath(new URL("../../examples/packs/", import.meta.url));
const EDUCATION = path.join(EXAMPLES, "education");
const HEALTH = path.join(EXAMPLES, "health");

/** Copies the education fixture into a throwaway pack dir and hands base and pack paths to `run`. */
async function withPackCopy(run) {
  const base = await mkdtemp(path.join(tmpdir(), "junctura-pack-"));
  const pack = path.join(base, "pack");
  await cp(EDUCATION, pack, { recursive: true });
  try {
    return await run(base, pack);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const readManifest = async pack => JSON.parse(await readFile(path.join(pack, "pack.json"), "utf8"));
const writeManifest = async (pack, manifest) => writeFile(path.join(pack, "pack.json"), JSON.stringify(manifest, null, 2));
const patchManifest = async (pack, patch) => {
  const manifest = await readManifest(pack);
  patch(manifest);
  await writeManifest(pack, manifest);
};

async function patchUnits(pack, patch) {
  const file = path.join(pack, "units.json");
  const units = JSON.parse(await readFile(file, "utf8"));
  patch(units);
  await writeFile(file, JSON.stringify(units, null, 2));
}

/** Asserts the result is not ok and carries at least one error with the given code and (when given) path. */
function assertRejected(result, code, at) {
  assert.equal(result.ok, false);
  assert.ok(Array.isArray(result.errors) && result.errors.length > 0, "a rejected pack reports errors");
  const hits = result.errors.filter(error => error.code === code && (at === undefined || error.path === at));
  assert.ok(hits.length > 0, `expected a ${code} error${at === undefined ? "" : ` at ${at}`}, got ${JSON.stringify(result.errors, null, 2)}`);
  return hits;
}

test("the education fixture reads unchanged", async () => {
  const result = await readPack(EDUCATION);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pack.manifest, JSON.parse(await readFile(path.join(EDUCATION, "pack.json"), "utf8")));
  assert.deepEqual(result.pack.units, JSON.parse(await readFile(path.join(EDUCATION, "units.json"), "utf8")));
  assert.deepEqual(result.pack.workflows.map(workflow => [workflow.id, workflow.bpmn, workflow.processId, workflow.userTaskIds]), [
    ["chuyentruong", "workflows/chuyen-truong.bpmn20.xml", "chuyentruong", ["tiep-nhan-ho-so", "xet-duyet", "thong-bao-ket-qua"]],
    ["capbansaohocba", "workflows/cap-ban-sao-hoc-ba.bpmn20.xml", "capbansaohocba", ["tiep-nhan-yeu-cau", "cap-ban-sao"]],
  ]);
  for (const workflow of result.pack.workflows) {
    assert.equal(workflow.xml, await readFile(path.join(EDUCATION, workflow.bpmn), "utf8"), `${workflow.bpmn} is read verbatim`);
  }
});

test("the health fixture reads unchanged", async () => {
  const result = await readPack(HEALTH);
  assert.equal(result.ok, true);
  assert.deepEqual(result.pack.manifest, JSON.parse(await readFile(path.join(HEALTH, "pack.json"), "utf8")));
  assert.deepEqual(result.pack.units, JSON.parse(await readFile(path.join(HEALTH, "units.json"), "utf8")));
  assert.deepEqual(result.pack.workflows.map(workflow => [workflow.id, workflow.processId, workflow.userTaskIds]), [
    ["chuyen-tuyen", "chuyen-tuyen", ["tiep-nhan-benh-nhan", "kham-va-chi-dinh", "phan-hoi-ket-qua"]],
    ["thanh-toan", "thanh-toan", ["lap-ho-so-chi", "duyet-thanh-toan"]],
  ]);
});

test("reading twice gives the same plain-data result", async () => {
  const first = await readPack(EDUCATION);
  const second = await readPack(EDUCATION);
  assert.deepEqual(first, second);
});

test("a missing or non-directory pack path is rejected", async () => {
  await withPackCopy(async base => {
    assertRejected(await readPack(path.join(base, "goi-khong-ton-tai")), PackReadErrorCode.PACK_DIR_UNREADABLE, "");
    const filePath = path.join(base, "tep-thuong");
    await writeFile(filePath, "khong phai thu muc");
    assertRejected(await readPack(filePath), PackReadErrorCode.PACK_DIR_UNREADABLE, "");
  });
});

test("a missing or unparseable manifest is rejected", async () => {
  await withPackCopy(async (base, pack) => {
    await rm(path.join(pack, "pack.json"));
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_MANIFEST_UNREADABLE, "");
    await writeFile(path.join(pack, "pack.json"), "{ chua dong ngoac");
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_MANIFEST_UNREADABLE, "");
  });
});

test("a missing or unparseable units file is rejected", async () => {
  await withPackCopy(async (base, pack) => {
    await rm(path.join(pack, "units.json"));
    const missing = await readPack(pack);
    const [missingError] = assertRejected(missing, PackReadErrorCode.PACK_UNITS_UNREADABLE, "");
    assert.equal(missingError.file, "units.json");
    await writeFile(path.join(pack, "units.json"), "{ chua dong ngoac");
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_UNITS_UNREADABLE, "");
  });
});

test("a missing BPMN file is rejected", async () => {
  await withPackCopy(async (base, pack) => {
    await rm(path.join(pack, "workflows", "chuyen-truong.bpmn20.xml"));
    const result = await readPack(pack);
    const [missingError] = assertRejected(result, PackReadErrorCode.PACK_BPMN_MISSING, "");
    assert.equal(missingError.file, "workflows/chuyen-truong.bpmn20.xml");
  });
});

test("schema violations report JSON paths and skip dependent reads", async () => {
  await withPackCopy(async (base, pack) => {
    await patchManifest(pack, manifest => { manifest.workflows[0].steps[0].deadlineDays = 0; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_MANIFEST_INVALID, "/workflows/0/steps/0/deadlineDays");

    await patchManifest(pack, manifest => { manifest.formatVersion = 2; });
    const broken = await readPack(pack);
    assertRejected(broken, PackReadErrorCode.PACK_MANIFEST_INVALID, "/formatVersion");
    assert.ok(!broken.errors.some(error => error.file === "units.json"), "a broken manifest stops dependent reads");

    await patchManifest(pack, manifest => {
      manifest.formatVersion = 1;
      manifest.workflows[0].steps[0].deadlineDays = 2;
    });
    await patchUnits(pack, units => { units.units[0].id = "9-vi-pham-mau-id"; });
    const unitsResult = await readPack(pack);
    const [unitsError] = assertRejected(unitsResult, PackReadErrorCode.PACK_UNITS_INVALID, "/units/0/id");
    assert.equal(unitsError.file, "units.json");
  });
});

test("duplicate ids are rejected in every scope", async () => {
  await withPackCopy(async (base, pack) => {
    await patchManifest(pack, manifest => { manifest.groups[1].id = manifest.groups[0].id; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_DUPLICATE_ID, "/groups/1/id");

    await patchManifest(pack, manifest => { manifest.workflows[0].steps[1].id = manifest.workflows[0].steps[0].id; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_DUPLICATE_ID, "/workflows/0/steps/1/id");

    await patchManifest(pack, manifest => { manifest.workflows[0].steps[0].decisions[1].id = "tiep-nhan"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_DUPLICATE_ID, "/workflows/0/steps/0/decisions/1/id");

    await patchManifest(pack, manifest => { manifest.workflows[0].open.form.fields[2].id = "ho-ten-hoc-sinh"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_DUPLICATE_ID, "/workflows/0/open/form/fields/2/id");

    await patchUnits(pack, units => { units.units[1].id = units.units[0].id; });
    const unitsResult = await readPack(pack);
    const [unitsError] = assertRejected(unitsResult, PackReadErrorCode.PACK_DUPLICATE_ID, "/units/1/id");
    assert.equal(unitsError.file, "units.json");
  });
});

test("dangling cross references are rejected", async () => {
  await withPackCopy(async (base, pack) => {
    await patchManifest(pack, manifest => { manifest.workflows[0].recordType = "loai-ho-so-ao"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_REF_NOT_FOUND, "/workflows/0/recordType");

    await patchManifest(pack, manifest => { manifest.workflows[0].senderUnitTypes.push("loai-don-vi-ao"); });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_REF_NOT_FOUND, "/workflows/0/senderUnitTypes/1");

    await patchManifest(pack, manifest => { manifest.workflows[0].receiverGroups.push("nhom-ao"); });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_REF_NOT_FOUND, "/workflows/0/receiverGroups/3");

    await patchManifest(pack, manifest => { manifest.workflows[0].open.role = "nhom-ao"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_REF_NOT_FOUND, "/workflows/0/open/role");

    await patchManifest(pack, manifest => { manifest.workflows[0].steps[0].role = "nhom-ao"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_REF_NOT_FOUND, "/workflows/0/steps/0/role");

    await patchUnits(pack, units => { units.units[0].unitType = "loai-don-vi-ao"; });
    const unitTypeError = await readPack(pack);
    const [typeError] = assertRejected(unitTypeError, PackReadErrorCode.PACK_REF_NOT_FOUND, "/units/0/unitType");
    assert.equal(typeError.file, "units.json");

    await patchUnits(pack, units => { units.units[1].parent = "don-vi-ao"; });
    const parentResult = await readPack(pack);
    const [parentError] = assertRejected(parentResult, PackReadErrorCode.PACK_REF_NOT_FOUND, "/units/1/parent");
    assert.equal(parentError.file, "units.json");
  });
});

test("open and step scopes are enforced against the workflow sides", async () => {
  await withPackCopy(async (base, pack) => {
    await patchManifest(pack, manifest => {
      manifest.unitTypes.push({ id: "thu-vien", name: "Thư viện" });
      manifest.groups.push({ id: "ke-toan", name: "Kế toán" });
      manifest.workflows[0].steps[0].unitTypes = ["thu-vien"];
    });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_STEP_UNIT_TYPE_NOT_ALLOWED, "/workflows/0/steps/0/unitTypes/0");

    await patchManifest(pack, manifest => { manifest.workflows[0].open.unitTypes = ["phong-giao-duc"]; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_OPEN_UNIT_TYPE_NOT_ALLOWED, "/workflows/0/open/unitTypes/0");

    await patchManifest(pack, manifest => { manifest.workflows[0].steps[0].role = "ke-toan"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_STEP_ROLE_NOT_IN_WORKFLOW, "/workflows/0/steps/0/role");

    await patchManifest(pack, manifest => { manifest.workflows[0].open.role = "lanh-dao"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_OPEN_ROLE_NOT_SENDER, "/workflows/0/open/role");
  });
});

test("a unit tree with two roots is rejected", async () => {
  await withPackCopy(async (base, pack) => {
    await patchUnits(pack, units => { units.units[1].parent = null; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_UNIT_TREE_INVALID, "/units");
  });
});

test("a parent cycle is rejected", async () => {
  await withPackCopy(async (base, pack) => {
    await patchUnits(pack, units => { units.units[0].parent = "truong-thcs-a2"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_UNIT_CYCLE, "/units/0/parent");
  });
});

test("a self parent is rejected", async () => {
  await withPackCopy(async (base, pack) => {
    await patchUnits(pack, units => { units.units[0].parent = units.units[0].id; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_UNIT_CYCLE, "/units/0/parent");
  });
});

test("BPMN ids must match the manifest in both directions", async () => {
  await withPackCopy(async (base, pack) => {
    await patchManifest(pack, manifest => { manifest.workflows[0].id = "khac-qua-trinh"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_BPMN_PROCESS_ID_MISMATCH, "/process/@id");

    await patchManifest(pack, manifest => { manifest.workflows[0].id = "chuyentruong"; manifest.workflows[0].steps[0].id = "buoc-ao"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_BPMN_STEP_MISMATCH, "/process/userTask");

    const bpmnPath = path.join(pack, "workflows", "chuyen-truong.bpmn20.xml");
    const xml = await readFile(bpmnPath, "utf8");
    await writeFile(bpmnPath, xml.replace("</process>", '<userTask id="them" name="Bước thêm" /></process>'));
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_BPMN_STEP_MISMATCH, "/process/userTask/@id");
  });
});

test("BPMN XML must be namespace-correct and free of DTDs", async () => {
  await withPackCopy(async (base, pack) => {
    const bpmnPath = path.join(pack, "workflows", "chuyen-truong.bpmn20.xml");
    const good = await readFile(bpmnPath, "utf8");
    const writeBpmn = xml => writeFile(bpmnPath, xml);

    await writeBpmn(good.replace("<definitions", '<!DOCTYPE definitions [<!ENTITY x SYSTEM "http://127.0.0.1:9/e.xml">]><definitions'));
    const dtd = await readPack(pack);
    const [dtdError] = assertRejected(dtd, PackReadErrorCode.PACK_BPMN_XML_INVALID, "");
    assert.match(dtdError.message, /DOCTYPE\/DTD/);

    await writeBpmn(good.replace('xmlns="http://www.omg.org/spec/BPMN/20100524/MODEL"', 'xmlns="urn:khac"'));
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_BPMN_XML_INVALID, "");

    await writeBpmn(good.replace("</process>", "<process id='hai' /></process>"));
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_BPMN_XML_INVALID, "");

    await writeBpmn(good.replace("</process>", '<userTask id="xet-duyet" name="Xét duyệt chuyển trường" /></process>'));
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_BPMN_XML_INVALID, "");

    await writeBpmn(good.replace("</process>", ""));
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_BPMN_XML_INVALID, "");
  });
});

test("references may not escape the pack directory, symlinks included", async () => {
  await withPackCopy(async (base, pack) => {
    await writeFile(path.join(base, "ngoai.bpmn20.xml"), "ben ngoai");
    // a lexical escape is caught by the schema first
    await patchManifest(pack, manifest => { manifest.workflows[0].bpmn = "../ngoai.bpmn20.xml"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_MANIFEST_INVALID, "/workflows/0/bpmn");

    // a symlink that passes the schema but resolves outside the pack
    await symlink(path.join(base, "ngoai.bpmn20.xml"), path.join(pack, "workflows", "ton-tai-ngoai.bpmn20.xml"));
    await patchManifest(pack, manifest => { manifest.workflows[0].bpmn = "workflows/ton-tai-ngoai.bpmn20.xml"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_BPMN_ESCAPE, "");

    // a symlink loop
    await symlink("vong.bpmn20.xml", path.join(pack, "workflows", "vong.bpmn20.xml"));
    await patchManifest(pack, manifest => { manifest.workflows[0].bpmn = "workflows/vong.bpmn20.xml"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_BPMN_UNREADABLE, "");

    // a directory instead of a regular file
    await rm(path.join(pack, "workflows", "chuyen-truong.bpmn20.xml"));
    await mkdir(path.join(pack, "workflows", "chuyen-truong.bpmn20.xml"));
    await patchManifest(pack, manifest => { manifest.workflows[0].bpmn = "workflows/chuyen-truong.bpmn20.xml"; });
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_BPMN_UNREADABLE, "");
  });
});

test("a symlink that stays inside the pack directory is followed", async () => {
  await withPackCopy(async (base, pack) => {
    await symlink(path.join(pack, "workflows", "chuyen-truong.bpmn20.xml"), path.join(pack, "workflows", "bi-danh.bpmn20.xml"));
    await patchManifest(pack, manifest => { manifest.workflows[0].bpmn = "workflows/bi-danh.bpmn20.xml"; });
    const result = await readPack(pack);
    assert.equal(result.ok, true);
    assert.equal(result.pack.workflows[0].processId, "chuyentruong");
  });
});

test("pack.json and the units file may not be symlinks out of the pack directory", async () => {
  await withPackCopy(async (base, pack) => {
    await writeFile(path.join(base, "pack-ngoai.json"), "{}");
    await rm(path.join(pack, "pack.json"));
    await symlink(path.join(base, "pack-ngoai.json"), path.join(pack, "pack.json"));
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_MANIFEST_ESCAPE, "");

    await cp(path.join(EDUCATION, "pack.json"), path.join(pack, "pack.json"), { recursive: true });
    await writeFile(path.join(base, "units-ngoai.json"), "{}");
    await rm(path.join(pack, "units.json"));
    await symlink(path.join(base, "units-ngoai.json"), path.join(pack, "units.json"));
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_UNITS_ESCAPE, "");
  });
});

test("a userTask outside the process cannot satisfy the manifest", async () => {
  await withPackCopy(async (base, pack) => {
    const bpmnPath = path.join(pack, "workflows", "chuyen-truong.bpmn20.xml");
    const good = await readFile(bpmnPath, "utf8");
    const writeBpmn = xml => writeFile(bpmnPath, xml);

    await writeBpmn(good
      .replace('<userTask id="xet-duyet"', '<subProcess id="con"><userTask id="xet-duyet"')
      .replace('<sequenceFlow id="f-xet-duyet-quyet-dinh"', '</subProcess><sequenceFlow id="f-xet-duyet-quyet-dinh"'));
    const subprocess = await readPack(pack);
    assert.equal(subprocess.ok, true);
    assert.deepEqual(subprocess.pack.workflows[0].userTaskIds, ["tiep-nhan-ho-so", "xet-duyet", "thong-bao-ket-qua"]);

    await writeBpmn(good
      .replace(/<userTask id="xet-duyet"[\s\S]*?<\/userTask>/, "")
      .replace("</process>", '</process>\n  <userTask id="xet-duyet" name="Xét duyệt chuyển trường" />'));
    const sibling = await readPack(pack);
    const [siblingError] = assertRejected(sibling, PackReadErrorCode.PACK_BPMN_STEP_MISMATCH, "/process/userTask");
    assert.match(siblingError.message, /"xet-duyet"/);
    assert.ok(!sibling.errors.some(error => error.code === PackReadErrorCode.PACK_BPMN_PROCESS_ID_MISMATCH), "the process id itself still matches");

    await writeBpmn(good
      .replace('<process id="chuyentruong"', "<wrap><process id=\"chuyentruong\"")
      .replace("</process>", "</process></wrap>"));
    assertRejected(await readPack(pack), PackReadErrorCode.PACK_BPMN_XML_INVALID, "");
  });
});
