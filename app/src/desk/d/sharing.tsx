// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

import { useEffect } from "react";
import { Card } from "@junctura/ui";
import { labelOf, usePack } from "../../pack/data";
import { DeskPage } from "../layout";
import { dataStrings as d } from "./strings";

/** Sends the browser to the merged page, keeping the old `/danh-muc` link alive. */
export function CatalogRedirect() {
  useEffect(() => { window.location.hash = "#/dieu-hanh/chia-se"; }, []);
  return null;
}

/**
 * D · Chia sẻ dữ liệu và năng lực: the workflow flows of the installed pack —
 * which unit types open a workflow and which receive and work on it — plus the
 * catalog of the pack's record types. Granting and revoking happens in the
 * Layer 1 Console, never here.
 */
export function DataSharingPage() {
  const pack = usePack();
  const label = labelOf(pack);

  return (
    <DeskPage title={d.sharing.title} lead={d.sharing.lead} current="/dieu-hanh/chia-se">
      <p className="text-sm text-ink-2">{d.sharing.consoleNote}</p>

      <Card title={d.sharing.flowTitle} className="mt-6">
        {!pack ? null : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[44rem] text-left text-sm">
              <thead className="border-b border-line bg-surface-2 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">{d.sharing.columnSender}</th>
                  <th scope="col" className="px-4 py-3 font-medium">{d.sharing.columnWorkflow}</th>
                  <th scope="col" className="px-4 py-3 font-medium">{d.sharing.columnReceiver}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {pack.workflows.map(workflow => (
                  <tr key={workflow.id} className="hover:bg-surface-2/60">
                    <td className="px-4 py-3">{workflow.senderUnitTypes.map(label).join(", ")}</td>
                    <td className="px-4 py-3 font-medium">{workflow.name}</td>
                    <td className="px-4 py-3">{workflow.receiverUnitTypes.map(label).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card title={d.catalog.title} className="mt-4">
        <p className="text-sm text-ink-2">{d.catalog.lead}</p>
        {!pack ? null : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[52rem] text-left text-sm">
              <thead className="border-b border-line bg-surface-2 text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">{d.catalog.columnRecordType}</th>
                  <th scope="col" className="px-4 py-3 font-medium">{d.catalog.columnDescription}</th>
                  <th scope="col" className="px-4 py-3 font-medium">{d.catalog.columnVersion}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {pack.recordTypes.map(recordType => (
                  <tr key={recordType.id} className="hover:bg-surface-2/60">
                    <td className="px-4 py-3">
                      <a href={`#/hop-dong/${recordType.id}`} className="font-medium text-brand hover:underline">{recordType.name}</a>
                    </td>
                    <td className="px-4 py-3 text-ink-2">{recordType.description ?? "—"}</td>
                    <td className="px-4 py-3 text-ink-2">{pack.pack.version}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </DeskPage>
  );
}
