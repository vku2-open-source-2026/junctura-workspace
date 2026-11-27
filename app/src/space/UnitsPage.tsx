// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorState, Skeleton } from "@junctura/ui";
import { usePackState } from "../pack/data";
import { SpacePage } from "./layout";
import { spaceStrings as s } from "./strings";

interface WorkflowRef {
  id: string;
  name: string;
  recordTypeId: string;
}

const WorkflowList = ({ items }: { items: readonly WorkflowRef[] }) => (
  <ul className="mt-2 space-y-1 text-sm">
    {items.length === 0
      ? <li className="text-muted">{s.units.none}</li>
      : items.map(item => (
          <li key={item.id}>
            <a href={`#/hop-dong/${item.recordTypeId}`} className="text-brand underline-offset-2 hover:underline">{item.name}</a>
          </li>
        ))}
  </ul>
);

/** One card per unit type of the pack: the workflows it may open and the ones it receives and works on. */
export function UnitsPage() {
  const { pack, failed } = usePackState();
  return (
    <SpacePage title={s.units.title} lead={s.units.lead} current="/co-so">
      {failed ? (
        <ErrorState title={s.packFailed.title} onRetry={() => window.location.reload()}>{s.packFailed.lead}</ErrorState>
      ) : !pack ? (
        <Skeleton lines={6} />
      ) : (
        <ul className="grid gap-5 lg:grid-cols-2">
          {pack.unitTypes.map(unitType => {
            const opens = pack.workflows
              .filter(workflow => workflow.senderUnitTypes.includes(unitType.id))
              .map(workflow => ({ id: workflow.id, name: workflow.name, recordTypeId: workflow.recordType }));
            const receives = pack.workflows
              .filter(workflow => workflow.receiverUnitTypes.includes(unitType.id))
              .map(workflow => ({ id: workflow.id, name: workflow.name, recordTypeId: workflow.recordType }));
            return (
              <li key={unitType.id} className="rounded-lg border border-line bg-surface p-5 shadow-card">
                <h2 className="text-lg font-semibold">{unitType.name}</h2>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  <div>
                    <h3 className="text-xs uppercase tracking-wide text-muted">{s.units.opens}</h3>
                    <WorkflowList items={opens} />
                  </div>
                  <div>
                    <h3 className="text-xs uppercase tracking-wide text-muted">{s.units.receives}</h3>
                    <WorkflowList items={receives} />
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SpacePage>
  );
}
