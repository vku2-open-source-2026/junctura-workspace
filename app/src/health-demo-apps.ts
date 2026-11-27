// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

export interface HealthDemoApp {
  readonly name: string;
  readonly key: string;
  readonly displayName: string;
}

declare const __HEALTH_APPS__: readonly HealthDemoApp[];

export const APPS = __HEALTH_APPS__;
