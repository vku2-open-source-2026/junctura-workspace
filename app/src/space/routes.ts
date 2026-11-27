// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

/** Routes of the case-type library pages, for the coordinator to wire into the app. */

import { spaceStrings } from "./strings";

export interface SpaceRoute {
  path: string;
  label: string;
}

export const SPACE_ROUTES: readonly SpaceRoute[] = [
  { path: "/hop-dong", label: spaceStrings.nav.types },
  { path: "/quy-trinh", label: spaceStrings.nav.workflows },
  { path: "/co-so", label: spaceStrings.nav.units },
];
