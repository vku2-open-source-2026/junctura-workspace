// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
// Workspace CI check of the real Junctura Health pack pinned in .junctura-health-version.
//
// The check verifies the pin before anything else: the version file must name
// a nonempty full commit revision and the pinned checkout must sit exactly at
// it (git -C .junctura-health rev-parse HEAD). Only then does it read the
// checkout's pack (docs/PACK_FORMAT.md) through server/packs.mjs readPack and
// assert the canonical pack id and its two definition keys. The pinned pack is
// the only industry pack that is not a Workspace fixture, so a stale checkout,
// a missing or malformed pack, or a drift in its definition keys must fail CI.
// `checkHealthPack` returns the problems and `main` exits nonzero on the first
// of them; server tests exercise the checker with the HEAD handed in as a
// value, so neither a local checkout nor git is required to run them.
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL, fileURLToPath } from "node:url";
import { readPack } from "../server/packs.mjs";

const exec = promisify(execFile);

/**
 * The pinned pack's canonical id and its two definition keys
 * (`.junctura-health/pack/pack.json`, pack v0.1.0): the record type ids and
 * the hyphen-free workflow process ids the Workspace depends on, in order.
 * The pack's own group and unit type lists keep evolving with the Health
 * domain and are deliberately not pinned.
 */
export const PINNED_HEALTH_PACK = Object.freeze({
  id: "health",
  recordTypes: Object.freeze(["chuyen-tuyen", "thanh-toan"]),
  workflows: Object.freeze(["chuyentuyen", "thanhtoan"]),
});

const REVISION = /^[0-9a-f]{40}$/;
const KEY_SECTIONS = ["recordTypes", "workflows"];

/** Reads `git -C <checkout> rev-parse HEAD`, or null when git cannot report it. */
async function readHead(checkout) {
  try {
    return (await exec("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" })).stdout.trim();
  } catch {
    return null;
  }
}

function describePack(manifest) {
  return {
    id: manifest.id,
    ...Object.fromEntries(KEY_SECTIONS.map(key =>
      [key, Array.isArray(manifest[key]) ? manifest[key].map(entry => entry?.id) : null])),
  };
}

/**
 * Checks one pinned Health pack: the version file names a nonempty full
 * revision, the checkout HEAD `head` (as `git rev-parse HEAD` reports it)
 * equals it exactly, readPack accepts the pack, and the pack's canonical id
 * and definition keys match `expected` (defaults to PINNED_HEALTH_PACK)
 * exactly, in order. The pin and the HEAD are verified before the pack is
 * read; a HEAD that is not the pinned revision — including an unreadable one
 * (`head` null or omitted) — stops the check without reading the pack.
 *
 * @param {string} versionFile Path of the version file, e.g. `.junctura-health-version`.
 * @param {string} packDir Path of the pack directory, e.g. `.junctura-health/pack`.
 * @param {{ id?: string, recordTypes?: string[], workflows?: string[] }} [expected] The pack identity and definition keys to expect.
 * @param {string} [head] The checkout's actual HEAD revision, or null/omitted when it could not be read.
 * @returns {Promise<string[]>} One human-readable problem per failure; empty when the pack is good.
 */
export async function checkHealthPack(versionFile, packDir, expected = PINNED_HEALTH_PACK, head) {
  const problems = [];

  let revision = null;
  try {
    revision = (await readFile(versionFile, "utf8")).trim();
  } catch (error) {
    problems.push(`the version file is unreadable: ${error.message}`);
  }
  if (revision != null && !REVISION.test(revision)) {
    problems.push(`the version file does not name a full commit revision: "${revision}"`);
  }
  if (problems.length) return problems;

  if (head !== revision) {
    problems.push(head
      ? `the pinned checkout is at ${head}, not the pinned revision ${revision}`
      : `the pinned checkout's HEAD could not be read with git -C ${path.dirname(packDir)} rev-parse HEAD; expected the pinned revision ${revision}`);
    return problems;
  }

  let manifest;
  const result = await readPack(packDir);
  if (result.ok) {
    manifest = result.pack.manifest;
  } else {
    const summary = result.errors.map(error => `${error.code} at ${error.file}${error.path} — ${error.message}`).join("; ");
    const missing = result.errors.every(error => error.code === "PACK_DIR_UNREADABLE");
    problems.push(`${missing ? "the pinned pack is missing" : "the pinned pack is malformed"}: ${summary}`);
  }

  if (manifest) {
    const actual = describePack(manifest);
    if (actual.id !== expected.id) {
      problems.push(`the pinned pack's id drifted from ${JSON.stringify(expected.id)} to ${JSON.stringify(actual.id)}`);
    }
    for (const section of KEY_SECTIONS) {
      if (JSON.stringify(actual[section]) !== JSON.stringify(expected[section])) {
        problems.push(`the pinned pack's ${section} drifted from ${JSON.stringify(expected[section])} to ${JSON.stringify(actual[section])}`);
      }
    }
  }

  return problems;
}

/** Runs the check on the Workspace root paths and exits 1 when it fails. */
export async function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const versionFile = path.join(root, ".junctura-health-version");
  const checkout = path.join(root, ".junctura-health");
  const packDir = path.join(checkout, "pack");
  const problems = await checkHealthPack(versionFile, packDir, PINNED_HEALTH_PACK, await readHead(checkout));
  if (problems.length) {
    process.stderr.write(`the pinned Junctura Health pack fails its checks:\n${problems.map(problem => `  - ${problem}`).join("\n")}\n`);
    process.exitCode = 1;
    return;
  }
  const revision = (await readFile(versionFile, "utf8")).trim();
  process.stdout.write(`the Junctura Health pack at ${path.relative(process.cwd(), packDir)} reads cleanly at the pinned revision ${revision}\n`);
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) await main();
