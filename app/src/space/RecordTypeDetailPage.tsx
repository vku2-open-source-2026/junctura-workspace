// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

import { Badge, Button, DataTable, EmptyState, ErrorState, Skeleton } from "@junctura/ui";
import type { Column } from "@junctura/ui";
import { navigateHash } from "../router";
import { recordTypeDetail, type FormFieldView, type RecordTypeWorkflowView } from "../catalog";
import { edgeLabel, edgesFrom, labelOf, nodeLabel, usePackState, type PackDiagram, type PackProjection } from "../pack/data";
import { SpacePage } from "./layout";
import { spaceStrings as s } from "./strings";

const fieldColumns: Column<FormFieldView>[] = [
  { key: "label", header: s.type.fields.name },
  { key: "type", header: s.type.fields.type, mono: true },
  { key: "required", header: s.type.fields.required, render: row => (row.required ? s.type.fields.required : s.type.fields.optional) },
  { key: "options", header: s.type.fields.options, render: row => (row.options.length > 0 ? row.options.join(", ") : "—") },
];

const FieldTable = ({ caption, rows }: { caption: string; rows: readonly FormFieldView[] }) => (
  <DataTable caption={caption} columns={fieldColumns} rows={[...rows]} rowKey={row => row.id} empty={s.type.noFields} className="mt-4" />
);

/**
 * The workflow diagram as a native, directly readable list: every business
 * node of the pack's BPMN with the acting groups, and — wherever a node has
 * more than one way forward — every branch with its user-facing decision
 * label, so both rejection routes stay visible.
 */
const Diagram = ({ diagram }: { diagram: PackDiagram }) => (
  <ol className="mt-4 space-y-3">
    {diagram.nodes.map((node, index) => {
      const branches = edgesFrom(diagram, node.id);
      return (
        <li key={node.id} className="flex items-start gap-3">
          <span aria-hidden className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-soft text-sm font-semibold text-brand">
            {index + 1}
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{nodeLabel(node)}</p>
            {node.groups && node.groups.length > 0 && (
              <p className="mt-0.5 text-xs text-muted">{s.workflows.groups}: {node.groups.join(", ")}</p>
            )}
            {branches.length > 1 && (
              <ul className="mt-1 space-y-0.5">
                {branches.map(edge => (
                  <li key={`${edge.from}->${edge.to}`} className="text-xs text-ink-2">
                    <span aria-hidden className="text-muted">→ </span>
                    {edgeLabel(diagram, edge)}
                    <span className="ml-1 font-mono text-[0.65rem] text-muted">{edge.to}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </li>
      );
    })}
  </ol>
);

const GroupList = ({ title, pack, ids }: { title: string; pack: PackProjection; ids: readonly string[] }) => (
  <div>
    <h4 className="text-xs uppercase tracking-wide text-muted">{title}</h4>
    <ul className="mt-2 space-y-1 text-sm">
      {ids.length === 0
        ? <li className="text-muted">{s.units.none}</li>
        : ids.map(id => <li key={id}>{labelOf(pack)(id)} <span className="font-mono text-xs text-muted">{id}</span></li>)}
    </ul>
  </div>
);

/** One pack workflow of the record type: diagram, SLA, forms and allowed groups. */
const WorkflowView = ({ pack, view }: { pack: PackProjection; view: RecordTypeWorkflowView }) => (
  <section aria-label={view.workflow.name} className="rounded-lg border border-line bg-surface p-5 shadow-card">
    <h2 className="text-lg font-semibold">{view.workflow.name}</h2>
    {view.workflow.description && <p className="mt-1 text-sm text-ink-2">{view.workflow.description}</p>}

    <section aria-label={s.type.diagram} className="mt-5">
      <h3 className="text-base font-semibold">{s.type.diagram}</h3>
      <Diagram diagram={view.diagram} />
    </section>

    <section aria-label={s.type.stepForms} className="mt-5">
      <h3 className="text-base font-semibold">{s.type.stepForms}</h3>
      <ol className="mt-4 space-y-5">
        {view.steps.map(step => (
          <li key={step.id} className="rounded-lg border border-dashed border-line bg-surface-2 p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="text-sm font-semibold">{step.name}</p>
              <p className="text-xs text-muted">
                <span className="font-medium">{s.type.sla}: </span>
                {step.deadlineDays} {s.type.slaDays}
              </p>
            </div>
            <p className="mt-1 text-xs text-muted">
              {s.workflows.groups}: {labelOf(pack)(step.role)} · {step.unitTypes.map(labelOf(pack)).join(", ")}
            </p>
            {step.fields.length > 0 && <FieldTable caption={step.name} rows={step.fields} />}
            <p className="mt-3 text-sm">
              <span className="font-medium">{s.type.decisions}: </span>
              {step.decisions.map(decision => (
                <span key={decision.id} className="mr-3 inline-block">
                  {decision.label}
                  {decision.requiresReason && <span className="ml-1 text-xs text-muted">({s.type.requiresReason})</span>}
                </span>
              ))}
            </p>
          </li>
        ))}
      </ol>
      <p className="mt-3 text-xs text-muted">{s.type.slaHint}</p>
    </section>

    <section aria-label={s.type.openForm} className="mt-5">
      <h3 className="text-base font-semibold">{s.type.openForm}</h3>
      <p className="mt-1 text-sm">
        <span className="font-medium">{s.type.openRole}: </span>
        {labelOf(pack)(view.workflow.open.role)}
      </p>
      <FieldTable caption={s.type.openForm} rows={view.openFields} />
    </section>

    <section aria-label={s.type.groupsTitle} className="mt-5">
      <h3 className="text-base font-semibold">{s.type.groupsTitle}</h3>
      <div className="mt-3 grid gap-4 sm:grid-cols-2">
        <GroupList title={s.type.senderGroups} pack={pack} ids={view.workflow.senderGroups} />
        <GroupList title={s.type.receiverGroups} pack={pack} ids={view.workflow.receiverGroups} />
        <GroupList title={s.type.senderUnitTypes} pack={pack} ids={view.workflow.senderUnitTypes} />
        <GroupList title={s.type.receiverUnitTypes} pack={pack} ids={view.workflow.receiverUnitTypes} />
      </div>
    </section>
  </section>
);

/** Library detail of one record type: diagram, forms, groups and SLA of every workflow; unknown ids get a not-found state. */
export function RecordTypeDetailPage({ slug }: { slug: string }) {
  const { pack, failed } = usePackState();
  if (failed) {
    return (
      <SpacePage title={s.types.title} current="/hop-dong">
        <ErrorState title={s.packFailed.title} onRetry={() => window.location.reload()}>{s.packFailed.lead}</ErrorState>
      </SpacePage>
    );
  }
  if (!pack) {
    return (
      <SpacePage title={s.types.title} current="/hop-dong">
        <Skeleton lines={6} />
      </SpacePage>
    );
  }
  const detail = recordTypeDetail(pack, slug);
  if (!detail) {
    return (
      <SpacePage title={s.types.title} current="/hop-dong">
        <EmptyState title={s.type.notFoundTitle}>{s.type.notFoundLead}</EmptyState>
        <p className="mt-4 text-center">
          <Button variant="secondary" onClick={() => navigateHash("/hop-dong")}>{s.type.backToList}</Button>
        </p>
      </SpacePage>
    );
  }
  return (
    <SpacePage title={detail.name} lead={detail.description} current="/hop-dong">
      <div className="space-y-8">
        <ul className="flex flex-wrap gap-2">
          <li><Badge tone="brand">{s.type.packVersion} {pack.pack.version}</Badge></li>
          <li><Badge tone="neutral">{detail.workflows.length} {s.type.workflowsTitle}</Badge></li>
        </ul>
        {detail.workflows.map(view => <WorkflowView key={view.workflow.id} pack={pack} view={view} />)}
      </div>
    </SpacePage>
  );
}
