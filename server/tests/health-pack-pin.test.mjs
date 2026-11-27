// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Tests of the CI check of the pinned Junctura Health pack (scripts/check-health-pack.mjs).
// The checker runs on a throwaway copy of the Workspace Education fixture in
// the OS temp dir with the checkout HEAD handed in as a value, so neither a
// `.junctura-health/` checkout nor git is needed: `npm --prefix server test`
// stays independently runnable, and the real pinned pack is asserted by the
// explicit CI step `node scripts/check-health-pack.mjs`.
import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkHealthPack, PINNED_HEALTH_PACK } from "../../scripts/check-health-pack.mjs";

const EXAMPLES = fileURLToPath(new URL("../../examples/packs/", import.meta.url));
const EDUCATION = path.join(EXAMPLES, "education");
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const VERSION_FILE = path.join(ROOT, ".junctura-health-version");
const PIN = "53b0a4041e2c54c7582686e494fb48d143728a25";
const OTHER_HEAD = "a24c8eb36c4719beaabe549eb033168eba705d12";

/** Copies the Education fixture into a throwaway pack dir and hands its paths to `run`. */
async function withPackCopy(run) {
  const base = await mkdtemp(path.join(tmpdir(), "junctura-pack-pin-"));
  const pack = path.join(base, "pack");
  await cp(EDUCATION, pack, { recursive: true });
  await writeFile(path.join(base, "version"), PIN);
  try {
    return await run(base, pack);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

const educationManifest = JSON.parse(await readFile(path.join(EDUCATION, "pack.json"), "utf8"));
const educationPack = {
  id: educationManifest.id,
  ...Object.fromEntries(["recordTypes", "workflows"].map(key =>
    [key, educationManifest[key].map(entry => entry.id)])),
};

test("the Workspace pin points at the promoted Junctura Health revision", async () => {
  assert.equal((await readFile(VERSION_FILE, "utf8")).trim(), PIN);
});

test("checkHealthPack accepts a valid pack whose checkout HEAD and definition keys match", async () => {
  await withPackCopy(async (base, pack) => {
    assert.deepEqual(await checkHealthPack(path.join(base, "version"), pack, educationPack, PIN), []);
  });
});

test("checkHealthPack fails when the pinned pack is missing", async () => {
  const missing = path.join(tmpdir(), `junctura-pack-pin-absent-${Date.now()}`);
  const problems = await checkHealthPack(VERSION_FILE, missing, PINNED_HEALTH_PACK, PIN);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /the pinned pack is missing/);
});

test("checkHealthPack fails when the version file is absent or not a full revision", async () => {
  await withPackCopy(async (base, pack) => {
    const absent = await checkHealthPack(path.join(base, "missing-version"), pack, educationPack, PIN);
    assert.equal(absent.length, 1);
    assert.match(absent[0], /unreadable/);

    await writeFile(path.join(base, "bad-version"), `${PIN.slice(0, 8)}\n`);
    const short = await checkHealthPack(path.join(base, "bad-version"), pack, educationPack, PIN);
    assert.equal(short.length, 1);
    assert.match(short[0], /full commit revision/);
  });
});

test("checkHealthPack rejects an empty pin", async () => {
  await withPackCopy(async (base, pack) => {
    await writeFile(path.join(base, "empty-version"), "");
    const empty = await checkHealthPack(path.join(base, "empty-version"), pack, educationPack, PIN);
    assert.equal(empty.length, 1);
    assert.match(empty[0], /full commit revision/);

    await writeFile(path.join(base, "blank-version"), "  \n");
    const blank = await checkHealthPack(path.join(base, "blank-version"), pack, educationPack, PIN);
    assert.equal(blank.length, 1);
    assert.match(blank[0], /full commit revision/);
  });
});

test("checkHealthPack fails when the checkout HEAD does not match the pin and does not read the pack", async () => {
  await withPackCopy(async (base, pack) => {
    const problems = await checkHealthPack(path.join(base, "version"), pack, educationPack, OTHER_HEAD);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /not the pinned revision/);
    assert.ok(problems[0].includes(OTHER_HEAD) && problems[0].includes(PIN));

    const missing = path.join(base, "absent-pack");
    const skipped = await checkHealthPack(path.join(base, "version"), missing, educationPack, OTHER_HEAD);
    assert.equal(skipped.length, 1);
    assert.match(skipped[0], /not the pinned revision/);
  });
});

test("checkHealthPack fails when the checkout HEAD is unreadable", async () => {
  await withPackCopy(async (base, pack) => {
    const problems = await checkHealthPack(path.join(base, "version"), pack, educationPack, null);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /HEAD could not be read/);
    assert.match(problems[0], /rev-parse HEAD/);
  });
});

test("checkHealthPack fails when the pinned pack is malformed", async () => {
  await withPackCopy(async (base, pack) => {
    await writeFile(path.join(pack, "pack.json"), "{ not json");
    const problems = await checkHealthPack(path.join(base, "version"), pack, educationPack, PIN);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /the pinned pack is malformed/);
    assert.match(problems[0], /PACK_MANIFEST_UNREADABLE/);
  });
});

test("checkHealthPack fails when the canonical pack id or its definition keys drift", async () => {
  await withPackCopy(async (base, pack) => {
    const problems = await checkHealthPack(path.join(base, "version"), pack, PINNED_HEALTH_PACK, PIN);
    assert.equal(problems.length, 3);
    assert.match(problems[0], /the pinned pack's id drifted/);
    assert.match(problems[1], /the pinned pack's recordTypes drifted/);
    assert.match(problems[2], /the pinned pack's workflows drifted/);
  });
});
