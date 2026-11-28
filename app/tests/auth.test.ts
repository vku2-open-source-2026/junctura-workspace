// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auth, codeChallenge, expiryOf, handleCallback, login, oidcEndpoints, refreshSession } from "../src/auth";
import { fallbackConfig, loadConfig } from "../src/config";

const ISSUER = "https://junctura.studio/identity/realms/junctura";
const PUBLIC_CONFIG = { juncturaUrl: "", issuer: ISSUER, clientId: "health-portal-web" };
const SAME_CLIENT_CONFIG = { juncturaUrl: "https://api.junctura.studio/", issuer: ISSUER, clientId: "portal-same-client", oidcMode: "same-client" as const };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  auth.clear("logout");
  sessionStorage.clear();
  window.history.replaceState(null, "", "/");
});

describe("PKCE", () => {
  it("computes the S256 challenge: base64url of the SHA-256 digest of the verifier", async () => {
    for (const verifier of ["dBjftJeZ4CVP-mB92K27uhbUJU1p0r_wC1EcBbGYyfs", "a".repeat(43), "trăm-dấu-gạch nối-1234567890"]) {
      const expected = createHash("sha256").update(verifier).digest("base64url");
      await expect(codeChallenge(verifier)).resolves.toBe(expected);
    }
  });
  it("round-trips through base64url without padding", async () => {
    const verifier = "a".repeat(43);
    const challenge = await codeChallenge(verifier);
    expect(challenge).not.toMatch(/[+/=]/);
    expect(Buffer.from(challenge, "base64url")).toEqual(createHash("sha256").update(verifier).digest());
  });
});

describe("OIDC endpoints", () => {
  it("keeps the public-client default: public issuer sign-in and the legacy same-origin proxy", () => {
    expect(oidcEndpoints(PUBLIC_CONFIG, "https://health.junctura.studio")).toEqual({
      authorization: `${ISSUER}/protocol/openid-connect/auth`,
      token: "https://health.junctura.studio/identity/realms/junctura/protocol/openid-connect/token",
      endSession: `${ISSUER}/protocol/openid-connect/logout`,
    });
  });
  it("uses juncturaUrl for the token request when the API is on another origin", () => {
    const config = { juncturaUrl: "http://127.0.0.1:8080/", issuer: "http://127.0.0.1:8080/identity/realms/junctura", clientId: "health-portal-web" };
    expect(oidcEndpoints(config, "http://localhost:5180").token).toBe("http://127.0.0.1:8080/identity/realms/junctura/protocol/openid-connect/token");
  });
  it("moves only the token exchange to the exact same-origin broker when opted in", () => {
    expect(oidcEndpoints(SAME_CLIENT_CONFIG, "https://health.junctura.studio")).toEqual({
      authorization: `${ISSUER}/protocol/openid-connect/auth`,
      token: "https://health.junctura.studio/api/auth/token",
      endSession: `${ISSUER}/protocol/openid-connect/logout`,
    });
  });
  it("keeps the configured client id in the public authorize redirect", async () => {
    const assign = vi.fn();
    vi.stubGlobal("window", {
      location: { origin: "https://health.junctura.studio", pathname: "/portal/", hash: "#/ho-so", assign },
    });
    await login(SAME_CLIENT_CONFIG);
    const target = new URL(assign.mock.calls[0]?.[0] as string);
    expect(target.origin + target.pathname).toBe(`${ISSUER}/protocol/openid-connect/auth`);
    expect(target.searchParams.get("client_id")).toBe("portal-same-client");
    expect(target.searchParams.get("redirect_uri")).toBe("https://health.junctura.studio/portal/");
  });
});

describe("same-client broker", () => {
  it("redeems the callback through the same-origin broker without keeping a refresh token", async () => {
    const origin = window.location.origin;
    const state = "state-1";
    window.history.replaceState(null, "", `/?code=code-1&state=${state}`);
    sessionStorage.setItem("junctura-portal-signin", JSON.stringify({ state, verifier: "v".repeat(43), returnTo: "#/lam-viec" }));
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
      return { ok: true, json: async () => ({ access_token: "access-1", expires_in: 300 }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(handleCallback(SAME_CLIENT_CONFIG)).resolves.toBe("#/lam-viec");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${origin}/api/auth/token`);
    expect(calls[0]?.body.get("grant_type")).toBe("authorization_code");
    expect(calls[0]?.body.get("client_id")).toBe("portal-same-client");
    expect(auth.get()).toMatchObject({ accessToken: "access-1", expiresAt: expect.any(Number) });
    expect(auth.get()).not.toHaveProperty("refreshToken");
  });
  it("does not attempt a broker refresh even when the session anomalously carries a refresh token", async () => {
    auth.set({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 300_000 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshSession(SAME_CLIENT_CONFIG)).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("still rejects a callback whose state does not match", async () => {
    window.history.replaceState(null, "", "/?code=code-1&state=wrong");
    sessionStorage.setItem("junctura-portal-signin", JSON.stringify({ state: "expected", verifier: "v".repeat(43), returnTo: "#/" }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(handleCallback(SAME_CLIENT_CONFIG)).rejects.toThrow("state_mismatch");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("legacy public refresh", () => {
  it("still renews the access token with the refresh token through the issuer token endpoint", async () => {
    auth.set({ accessToken: "access-1", refreshToken: "refresh-1", expiresAt: Date.now() + 300_000 });
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: new URLSearchParams(String(init?.body ?? "")) });
      return { ok: true, json: async () => ({ access_token: "access-2", refresh_token: "refresh-2", expires_in: 300 }) } as Response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshSession(PUBLIC_CONFIG)).resolves.toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${window.location.origin}/identity/realms/junctura/protocol/openid-connect/token`);
    expect(calls[0]?.body.get("grant_type")).toBe("refresh_token");
    expect(calls[0]?.body.get("refresh_token")).toBe("refresh-1");
    expect(auth.get()).toMatchObject({ accessToken: "access-2", refreshToken: "refresh-2" });
  });
});

describe("portal config", () => {
  const base = { juncturaUrl: "", issuer: ISSUER, clientId: "health-portal-web" };
  const fetchJson = (value: unknown) => (async () => ({ ok: true, json: async () => value }) as Response) as unknown as typeof fetch;

  it("keeps the public-client default and accepts only the same-client opt-in", async () => {
    await expect(loadConfig(fetchJson(base))).resolves.toEqual(base);
    await expect(loadConfig(fetchJson({ ...base, oidcMode: "same-client" }))).resolves.toEqual({ ...base, oidcMode: "same-client" });
    expect(fallbackConfig("https://health.junctura.studio")).toEqual({
      juncturaUrl: "", issuer: "https://health.junctura.studio/identity/realms/junctura", clientId: "health-portal-web",
    });
  });
  it("falls back to the default when the mode is malformed", async () => {
    for (const oidcMode of ["other", "", null, true, 1]) {
      await expect(loadConfig(fetchJson({ ...base, oidcMode }))).resolves.toEqual(fallbackConfig());
    }
  });
});

describe("session expiry", () => {
  it("renews by the earlier of the access and refresh token expiries", () => {
    const now = Date.now();
    const at = expiryOf({ expires_in: 3600, refresh_expires_in: 1800 }) ?? 0;
    expect(at - now).toBeGreaterThanOrEqual(1800 * 1000 - 50);
    expect(at - now).toBeLessThan(1801 * 1000);
    expect((expiryOf({ expires_in: 300 }) ?? 0) - now).toBeLessThan(301 * 1000);
    expect(expiryOf({})).toBeUndefined();
  });
});
