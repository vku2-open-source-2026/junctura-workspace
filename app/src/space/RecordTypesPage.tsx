// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

import { Badge, ErrorState, Skeleton } from "@junctura/ui";
import { recordTypeCatalog } from "../catalog";
import { usePackState } from "../pack/data";
import { strings } from "../strings";
import { SpacePage } from "./layout";
import { spaceStrings as s } from "./strings";

/** The case-type library list: one card per record type of the active pack. */
export function RecordTypesPage() {
  const { pack, failed } = usePackState();
  return (
    <SpacePage title={s.types.title} lead={s.types.lead} current="/hop-dong">
      {failed ? (
        <ErrorState title={s.packFailed.title} onRetry={() => window.location.reload()}>{s.packFailed.lead}</ErrorState>
      ) : !pack ? (
        <Skeleton lines={6} />
      ) : (
        <ul className="grid gap-5 sm:grid-cols-2">
          {recordTypeCatalog(pack).map(entry => (
            <li key={entry.id}>
              <a
                href={`#/hop-dong/${entry.id}`}
                className="block h-full rounded-lg border border-line bg-surface p-5 shadow-card transition hover:border-brand"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="text-lg font-semibold">{entry.name}</h2>
                  <Badge tone="brand">{entry.workflowCount} {strings.catalog.workflowCount}</Badge>
                </div>
                {entry.description && <p className="mt-2 text-sm text-ink-2">{entry.description}</p>}
                <p className="mt-3 text-sm font-medium text-brand">{s.types.openDetail} →</p>
              </a>
            </li>
          ))}
        </ul>
      )}
    </SpacePage>
  );
}
