// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import type { HealthDemoApp } from "./src/health-demo-apps";

const JUNCTURA_URL = process.env.JUNCTURA_URL ?? "http://127.0.0.1:8080";
const PORTAL_API_URL = process.env.PORTAL_API_URL ?? "http://127.0.0.1:5190";

// The demo plan imports Node modules. Pass its public catalog to the browser as data.
const { APPS }: { APPS: readonly HealthDemoApp[] } = await import(
  new URL("../.junctura-health/demo/plan.mjs", import.meta.url).href
);
const publicApps = APPS.map(({ name, key, displayName }) => ({ name, key, displayName }));

// The UI library sources live outside this package and pull React through
// ../.junctura-health/ui/node_modules. To guarantee exactly one React (tests and bundle), pin every
// react/react-dom import to this package's own copies.
const ownModule = (name: string): string => fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));

// The shared UI library and the pure data modules (contracts, demo plan) are
// loaded from the pinned Junctura Health checkout.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: { __HEALTH_APPS__: JSON.stringify(publicApps) },
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${ownModule("react")}/index.js` },
      { find: /^react\/(.*)$/, replacement: `${ownModule("react")}/$1` },
      { find: /^react-dom$/, replacement: `${ownModule("react-dom")}/index.js` },
      { find: /^react-dom\/(.*)$/, replacement: `${ownModule("react-dom")}/$1` },
      { find: /^lucide-react$/, replacement: ownModule("lucide-react") },
      { find: /^@fontsource-variable\/(.*)$/, replacement: `${ownModule("@fontsource-variable")}/$1` },
      { find: "@junctura/health-ui", replacement: fileURLToPath(new URL("../.junctura-health/ui/src/index.ts", import.meta.url)) },
      { find: "@junctura/health-contracts", replacement: fileURLToPath(new URL("../.junctura-health/contracts/index.mjs", import.meta.url)) },
      { find: "@junctura/health-workflows", replacement: fileURLToPath(new URL("../.junctura-health/workflows", import.meta.url)) },
    ],
    // Resolution fallback for bare imports from the transformed library tree: force
    // react/react-dom to this package's root node_modules (single copy, see alias above).
    dedupe: ["react", "react-dom", "lucide-react"],
  },
  server: {
    // Sources used from outside this package; never the full Junctura Health checkout (it may hold local demo credentials).
    fs: { allow: [".", "../.junctura-health/ui", "../.junctura-health/contracts", "../.junctura-health/workflows", "../.junctura-health/seed/data/accounts.json"].map(path => fileURLToPath(new URL(path, import.meta.url))) },
    port: 5180,
    // Layer 1 behind the same origin in dev, as the deployed portal proxies /v1 and /identity;
    // /api goes to the portal backend.
    proxy: {
      "/v1": JUNCTURA_URL,
      "/identity": JUNCTURA_URL,
      "/api": PORTAL_API_URL,
    },
  },
  // Never inline assets as data: URIs: the served CSP allows fonts and scripts from 'self' only.
  build: { sourcemap: true, assetsInlineLimit: 0 },
  test: {
    environment: "jsdom",
    setupFiles: ["tests/setup.ts"],
    include: ["tests/**/*.test.{ts,tsx}"],
    css: false,
    // Run every dependency through Vite in tests (nothing native), so the React
    // aliases/dedupe above hold everywhere and exactly one React copy is loaded.
    server: { deps: { inline: true } },
  },
});
