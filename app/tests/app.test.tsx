// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortalApp } from "../src/App";
import { auth } from "../src/auth";
import { EDUCATION_PACK, HEALTH_PACK } from "./helpers";
import { strings } from "../src/strings";

afterEach(() => {
  vi.unstubAllGlobals();
  window.location.hash = "";
});

/**
 * The runtime-pack proof at the boundary: the same `<PortalApp />` bundle is
 * rendered twice, receiving first the education pack projection and then the
 * health one from `GET /api/pack`, and the landing must show each pack's own
 * recognizable record types and unit types.
 */
const packResponse = (pack: typeof EDUCATION_PACK) =>
  vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("api/pack")) return new Response(JSON.stringify(pack), { status: 200 });
    return new Response("{}", { status: 404 });
  });

describe("public landing", () => {
  it("renders the case-type catalog of the education pack at runtime", async () => {
    vi.stubGlobal("fetch", packResponse(EDUCATION_PACK));
    render(<PortalApp />);
    expect(await screen.findByText(strings.landing.catalogTitle)).toBeTruthy();
    for (const recordType of EDUCATION_PACK.recordTypes) {
      expect(await screen.findByText(recordType.name)).toBeTruthy();
    }
    for (const unitType of EDUCATION_PACK.unitTypes) {
      expect(screen.getAllByText(unitType.name).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText("Hồ sơ chuyển tuyến")).toBeNull();
  });

  it("renders the health pack's own catalog from the same bundle when the configuration changes", async () => {
    vi.stubGlobal("fetch", packResponse(HEALTH_PACK));
    render(<PortalApp />);
    expect(await screen.findByText(strings.landing.catalogTitle)).toBeTruthy();
    for (const recordType of HEALTH_PACK.recordTypes) {
      expect(await screen.findByText(recordType.name)).toBeTruthy();
    }
    for (const unitType of HEALTH_PACK.unitTypes) {
      expect(screen.getAllByText(unitType.name).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText("Hồ sơ chuyển trường")).toBeNull();
  });

  it("links every catalog card on the home page to its record-type page", async () => {
    vi.stubGlobal("fetch", packResponse(EDUCATION_PACK));
    render(<PortalApp />);
    await screen.findByText(strings.landing.catalogTitle);
    for (const recordType of EDUCATION_PACK.recordTypes) {
      expect(screen.getByRole("link", { name: recordType.name }).getAttribute("href")).toBe(`#/hop-dong/${recordType.id}`);
    }
  });

  it("links to the workspace instead of signing anyone in on the public page", async () => {
    vi.stubGlobal("fetch", packResponse(EDUCATION_PACK));
    render(<PortalApp />);
    await screen.findByText(strings.landing.catalogTitle);
    const links = screen.getAllByRole("link", { name: strings.app.signIn });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute("href")).toBe("#/lam-viec");
    expect(screen.queryByText(strings.signIn.subtitle)).toBeNull();
  });

  it("never calls the Junctura API while rendering, only the portal's own pack route", async () => {
    const fetchMock = packResponse(EDUCATION_PACK);
    vi.stubGlobal("fetch", fetchMock);
    render(<PortalApp />);
    await screen.findByText(strings.landing.catalogTitle);
    for (const call of fetchMock.mock.calls) {
      const url = new URL(String(call[0]), "http://localhost:5180");
      expect(url.pathname).not.toMatch(/^\/(v1|v2|identity)(\/|$)/);
    }
  });
});

describe("routes", () => {
  afterEach(() => { window.location.hash = ""; });

  it("maps every hash route to its page and unknown routes to the home page", async () => {
    vi.stubGlobal("fetch", packResponse(EDUCATION_PACK));
    const { pageFor } = await import("../src/App");
    const recordType = EDUCATION_PACK.recordTypes[0];
    const { PackContext } = await import("../src/pack/data");
    const { unmount } = render(<PackContext.Provider value={{ pack: EDUCATION_PACK, failed: false }}>{pageFor(`/hop-dong/${recordType.id}`)}</PackContext.Provider>);
    expect(await screen.findByText(recordType.name)).toBeTruthy();
    unmount();
    for (const route of ["/hop-dong", "/quy-trinh", "/co-so", "/khong-co", "/hop-dong/../../etc"]) {
      const view = render(pageFor(route));
      expect(view.container.textContent?.length).toBeGreaterThan(0);
      view.unmount();
    }
  });
});

describe("pack load failure", () => {
  it("shows a visible failure instead of loading forever when the pack cannot be fetched", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 500 })));
    render(<PortalApp />);
    expect(await screen.findByText(strings.landing.packFailedTitle, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText(strings.landing.packFailed)).toBeTruthy();
  });
});

describe("workspace gate", () => {
  afterEach(() => { auth.clear("logout"); window.location.hash = ""; });

  it("asks staff to sign in before anything else", async () => {
    vi.stubGlobal("fetch", packResponse(EDUCATION_PACK));
    window.location.hash = "#/dieu-phoi";
    render(<PortalApp />);
    expect(await screen.findByText(strings.signIn.subtitle)).toBeTruthy();
    expect(screen.getByText(strings.signIn.note)).toBeTruthy();
    expect(await waitFor(() => screen.queryByText(strings.app.name))).toBeTruthy();
  });

  it("does not open the desk for an account the backend does not verify as staff", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("api/me")) return new Response(JSON.stringify({ error: "forbidden" }), { status: 403 });
      return new Response("{}", { status: 404 });
    }));
    auth.set({ accessToken: "e30.e30.sig" });
    window.location.hash = "#/dieu-phoi";
    render(<PortalApp />);
    expect(await screen.findByText(strings.signIn.notStaff, {}, { timeout: 4000 })).toBeTruthy();
  });

  it("shows the existing failure message when the backend is unusable instead of waiting forever", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("api/me")) return new Response(JSON.stringify({ error: "junctura_unavailable" }), { status: 503 });
      return new Response("{}", { status: 404 });
    }));
    auth.set({ accessToken: "e30.e30.sig" });
    window.location.hash = "#/dieu-phoi";
    render(<PortalApp />);
    expect(await screen.findByText(strings.signIn.failed, {}, { timeout: 4000 })).toBeTruthy();
    expect(screen.queryByText(strings.signIn.notStaff)).toBeNull();
  });

  it("opens the desk with the identity the backend verified and redirects the old desk home", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("api/me")) {
        return new Response(JSON.stringify({
          username: "nv-truong", displayName: "Nguyễn Văn A", facility: "truong", groups: ["/truong/hoc-vu"], canPublish: false,
        }), { status: 200 });
      }
      if (url.endsWith("api/pack")) return new Response(JSON.stringify(EDUCATION_PACK), { status: 200 });
      return new Response("{}", { status: 404 });
    }));
    auth.set({ accessToken: "e30.e30.sig" });
    window.location.hash = "#/dieu-phoi";
    render(<PortalApp />);
    await vi.waitFor(() => {
      expect(window.location.hash).toBe("#/lam-viec");
    });
    await vi.waitFor(() => {
      expect(screen.getAllByText("Nguyễn Văn A").length).toBeGreaterThan(0);
    });
    expect(screen.getAllByText("Trường học").length).toBeGreaterThan(0);
    expect(screen.queryByText(strings.signIn.notStaff)).toBeNull();
  });
});
