// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const JUNCTURA_URL = process.env.JUNCTURA_URL ?? "http://127.0.0.1:8080";
const PORTAL_API_URL = process.env.PORTAL_API_URL ?? "http://127.0.0.1:5190";

// The UI library sources live outside this package and pull React through
// ../packages/ui/node_modules. To guarantee exactly one React (tests and
// bundle), pin every react/react-dom import to this package's own copies.
const ownModule = (name: string): string => fileURLToPath(new URL(`./node_modules/${name}`, import.meta.url));

// The whole portal builds from this repository only: the shared UI library in
// packages/ui and the pack data it fetches at runtime from the backend. No
// industry checkout is a build input.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      { find: /^react$/, replacement: `${ownModule("react")}/index.js` },
      { find: /^react\/(.*)$/, replacement: `${ownModule("react")}/$1` },
      { find: /^react-dom$/, replacement: `${ownModule("react-dom")}/index.js` },
      { find: /^react-dom\/(.*)$/, replacement: `${ownModule("react-dom")}/$1` },
      { find: /^lucide-react$/, replacement: ownModule("lucide-react") },
      { find: /^@fontsource-variable\/(.*)$/, replacement: `${ownModule("@fontsource-variable")}/$1` },
      { find: "@junctura/ui", replacement: fileURLToPath(new URL("../packages/ui/src/index.ts", import.meta.url)) },
    ],
    // Resolution fallback for bare imports from the transformed library tree: force
    // react/react-dom to this package's root node_modules (single copy, see alias above).
    dedupe: ["react", "react-dom", "lucide-react"],
  },
  server: {
    // Sources used from outside this package: the shared UI library and the
    // canonical example packs the tests read as BPMN fixtures.
    fs: { allow: [".", "../packages/ui", "../examples"].map(path => fileURLToPath(new URL(path, import.meta.url))) },
    port: 5180,
    // Layer 1 behind the same origin in dev, as the deployed portal proxies /v1 and /identity;
    // /api goes to the portal backend, which also serves the public pack projection.
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
