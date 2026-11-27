<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

## Unreleased

- Specify the Workspace pack format v1 in docs/PACK_FORMAT.md with draft 2020-12 JSON Schemas in `schemas/`, synthetic Education and Health fixtures in `examples/packs/`, and a dev-only jsonschema contract check in `scripts/check-pack-schemas.py` wired into CI.
- Extract the shared UI package `@junctura/ui@0.1.0-rc` under `packages/ui/` from the pinned Junctura Health library: 21 components, design tokens, styles and fonts, with health-domain defaults removed so apps supply them via props (quick find keeps only the neutral `Tìm kiếm` placeholder). CI typechecks, tests, builds and packs the package before the app checks.
- Import the Junctura Health portal and backend while preserving the portal's commit history.
- Add CI for license metadata, Compose configuration, backend tests, and frontend type checking, tests and build.
- Add the local pack reader and preflight in `server/packs.mjs`: `readPack(packDir)` validates a pack with the published draft 2020-12 schemas (Ajv), parses BPMN namespace-aware and rejects DTDs/external references, proves file containment including symlinks before opening references, and enforces the documented cross-file checks (duplicate ids, dangling references, open/step scopes, unit tree with one root, BPMN process/userTask ids) returning `{ ok, pack | errors }` with stable error codes and paths. Covered by focused reader tests and documented in docs/PACK_FORMAT.md; the version upgrade check of `pack:install` is left to issue #12.
- Add contributing and security policies plus issue templates for tasks and bugs.
