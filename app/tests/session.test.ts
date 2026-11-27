// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { fetchStaffProfile, staffFromMe } from "../src/session";

const me = {
  username: "nv-truong",
  displayName: "Nguyễn Văn A",
  facility: "truong",
  groups: ["/truong/hoc-vu", "/phong-giao-duc/van-thu"],
  canPublish: false,
};

describe("staffFromMe", () => {
  it("accepts the verified identity the backend answers for the caller", () => {
    expect(staffFromMe(me)).toEqual(me);
  });

  it("refuses anything that is not a well-formed staff answer", () => {
    for (const broken of [
      null, undefined, "staff", 42, [],
      { ...me, username: "" },
      { ...me, displayName: 42 },
      { ...me, facility: null },
      { ...me, groups: "truong/hoc-vu" },
      { ...me, groups: ["/truong/hoc-vu", 42] },
      { ...me, canPublish: "no" },
      { username: "nv-truong", displayName: "Nguyễn Văn A", facility: "truong", groups: [] },
    ]) {
      expect(staffFromMe(broken)).toBeNull();
    }
  });
});

describe("fetchStaffProfile", () => {
  it("maps a good /api/me answer to the staff profile", async () => {
    expect(await fetchStaffProfile(async () => me)).toEqual(me);
  });

  it("lets a refusing backend surface as a fetch error, not as a staff answer", async () => {
    await expect(fetchStaffProfile(async () => {
      throw Object.assign(new Error("api"), { status: 403, code: "forbidden" });
    })).rejects.toThrow();
  });

  it("lets a malformed answer count as not staff", async () => {
    expect(await fetchStaffProfile(async () => ({ error: "x" }))).toBeNull();
  });
});
