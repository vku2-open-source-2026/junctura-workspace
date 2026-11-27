<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Changelog

## Unreleased

- Extract the shared UI package `@junctura/ui@0.1.0-rc` under `packages/ui/` from the pinned Junctura Health library: 21 components, design tokens, styles and fonts, with health-domain defaults removed so apps supply them via props (quick find keeps only the neutral `Tìm kiếm` placeholder). CI typechecks, tests, builds and packs the package before the app checks.
- Import the Junctura Health portal and backend while preserving the portal's commit history.
- Add CI for license metadata, Compose configuration, backend tests, and frontend type checking, tests and build.
