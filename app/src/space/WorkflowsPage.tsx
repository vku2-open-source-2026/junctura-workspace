// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

import { ErrorState, Skeleton } from "@junctura/ui";
import { edgeLabel, edgesFrom, labelOf, nodeLabel, usePackState } from "../pack/data";
import { SpacePage } from "./layout";
import { spaceStrings as s } from "./strings";

/** The pack workflows as readable diagrams: every node, every branch with its label, and the acting groups. */
export function WorkflowsPage() {
  const { pack, failed } = usePackState();
  return (
    <SpacePage title={s.workflows.title} lead={s.workflows.lead} current="/quy-trinh">
      {failed ? (
        <ErrorState title={s.packFailed.title} onRetry={() => window.location.reload()}>{s.packFailed.lead}</ErrorState>
      ) : !pack ? (
        <Skeleton lines={6} />
      ) : (
        <ul className="space-y-5">
          {pack.workflows.map(workflow => (
            <li key={workflow.id} className="rounded-lg border border-line bg-surface p-5 shadow-card">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-lg font-semibold">{workflow.name}</h2>
                <p className="text-sm text-muted">{workflow.diagram.nodes.length} {s.workflows.stepCount}</p>
              </div>
              {workflow.description && <p className="mt-1 text-sm text-ink-2">{workflow.description}</p>}
              <ol className="mt-4 space-y-3">
                {workflow.diagram.nodes.map((node, index) => {
                  const branches = edgesFrom(workflow.diagram, node.id);
                  return (
                    <li key={node.id} className="flex items-start gap-3">
                      <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-sm font-semibold text-brand">
                        {index + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium">{nodeLabel(node)}</p>
                        {node.groups && node.groups.length > 0 && (
                          <p className="mt-0.5 text-xs text-muted">
                            {s.workflows.groups}: {node.groups.map(labelOf(pack)).join(", ")}
                          </p>
                        )}
                        {branches.length > 1 && (
                          <ul className="mt-1 space-y-0.5">
                            {branches.map(edge => (
                              <li key={`${edge.from}->${edge.to}`} className="text-xs text-ink-2">
                                <span aria-hidden className="text-muted">→ </span>
                                {edgeLabel(workflow.diagram, edge)}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </li>
          ))}
        </ul>
      )}
    </SpacePage>
  );
}
