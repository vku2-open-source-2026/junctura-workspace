// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import type { ReactElement, ReactNode } from "react";
import { render } from "@testing-library/react";
import { DeskProvider } from "../src/desk/context";
import { PackContext } from "../src/pack/data";
import type { PackFieldType, PackOutcome, PackProjection, PackWorkflow } from "../src/pack/types";
import type { DeskStaff } from "../src/desk/context";
// The diagram comes from the real server projection code, so the fixtures are
// exactly what `GET /api/pack` would serve for these packs.
import { diagramOf } from "../../server/bpmn-diagram.mjs";

/**
 * Test fixtures built from the two canonical packs of the repository, so the
 * same components are proven against two sectors with recognizable, divergent
 * content. The projector below mirrors the whitelist of
 * server/pack-projection.mjs; the BPMN sources are the real pack files.
 */
import healthManifest from "../../examples/packs/health/pack.json";
import educationManifest from "../../examples/packs/education/pack.json";
import healthChuyenTuyen from "../../examples/packs/health/workflows/chuyen-tuyen.bpmn20.xml?raw";
import healthThanhToan from "../../examples/packs/health/workflows/thanh-toan.bpmn20.xml?raw";
import educationChuyenTruong from "../../examples/packs/education/workflows/chuyen-truong.bpmn20.xml?raw";
import educationCapBanSao from "../../examples/packs/education/workflows/cap-ban-sao-hoc-ba.bpmn20.xml?raw";

interface JsonField { id: string; label: string; type: PackFieldType; required?: boolean; options?: string[] }
interface JsonForm { fields: JsonField[] }
interface JsonDecision { id: string; label: string; outcome: PackOutcome; requiresReason?: boolean }
interface JsonStep { id: string; name: string; role: string; unitTypes: string[]; deadlineDays: number; form?: JsonForm; decisions: JsonDecision[] }
interface JsonWorkflow {
  id: string;
  name: string;
  description?: string;
  recordType: string;
  senderUnitTypes: string[];
  receiverUnitTypes: string[];
  senderGroups: string[];
  receiverGroups: string[];
  open: { role: string; form: JsonForm };
  steps: JsonStep[];
}
interface JsonManifest {
  id: string;
  name: string;
  description?: string;
  version: string;
  language: string;
  groups: { id: string; name: string; description?: string }[];
  unitTypes: { id: string; name: string }[];
  recordTypes: { id: string; name: string; description?: string }[];
  workflows: JsonWorkflow[];
}

const projectFields = (fields: readonly JsonField[]) =>
  fields.map(field => ({
    id: field.id,
    label: field.label,
    type: field.type,
    ...(field.required === true ? { required: true } : {}),
    ...(field.options ? { options: field.options } : {}),
  }));

/** The whitelisted projection of one example pack, BPMN inlined per workflow id. */
export function projectPack(manifest: JsonManifest, xmlOf: (workflowId: string) => string): PackProjection {
  return {
    pack: {
      id: manifest.id,
      name: manifest.name,
      ...(manifest.description ? { description: manifest.description } : {}),
      version: manifest.version,
      language: manifest.language,
    },
    groups: manifest.groups.map(({ id, name }) => ({ id, name })),
    unitTypes: manifest.unitTypes.map(({ id, name }) => ({ id, name })),
    recordTypes: manifest.recordTypes.map(({ id, name, description }) => ({
      id, name,
      ...(description ? { description } : {}),
    })),
    workflows: manifest.workflows.map(workflow => ({
      id: workflow.id,
      name: workflow.name,
      ...(workflow.description ? { description: workflow.description } : {}),
      recordType: workflow.recordType,
      senderUnitTypes: [...workflow.senderUnitTypes],
      receiverUnitTypes: [...workflow.receiverUnitTypes],
      senderGroups: [...workflow.senderGroups],
      receiverGroups: [...workflow.receiverGroups],
      open: { role: workflow.open.role, form: { fields: projectFields(workflow.open.form.fields) } },
      steps: workflow.steps.map(step => ({
        id: step.id,
        name: step.name,
        role: step.role,
        unitTypes: [...step.unitTypes],
        deadlineDays: step.deadlineDays,
        ...(step.form ? { form: { fields: projectFields(step.form.fields) } } : {}),
        decisions: step.decisions.map(decision => ({
          id: decision.id,
          label: decision.label,
          outcome: decision.outcome,
          ...(decision.requiresReason === true ? { requiresReason: true } : {}),
        })),
      })),
      diagram: diagramOf(xmlOf(workflow.id), workflow.steps),
    })),
  };
}

export const HEALTH_PACK = projectPack(
  healthManifest as unknown as JsonManifest,
  id => (id === "chuyen-tuyen" ? healthChuyenTuyen : healthThanhToan) as string,
);

export const EDUCATION_PACK = projectPack(
  educationManifest as unknown as JsonManifest,
  id => (id === "chuyentruong" ? educationChuyenTruong : educationCapBanSao) as string,
);

/** The workflow of a fixture pack by id, with a check that it exists. */
export const workflowOf = (pack: PackProjection, id: string): PackWorkflow => {
  const workflow = pack.workflows.find(candidate => candidate.id === id);
  if (!workflow) throw new Error(`không có quy trình ${id} trong gói ${pack.pack.id}`);
  return workflow;
};

// ---------------------------------------------------------------- staff

/** A desk staff member for a facility, verified in the named role groups. */
export const staffOf = (facility: string, groups: readonly string[], canPublish = false): DeskStaff => ({
  username: `nv-${facility}`,
  displayName: "Nguyễn Văn A",
  facility,
  groups,
  canPublish,
});

/** A health-sector nurse: unit `tram-y-te`, verified group `/tram-y-te/y-ta`. */
export const HEALTH_NURSE = staffOf("tram-y-te", ["/tram-y-te/y-ta"]);

/** An education-sector academic-affairs member: unit `truong`, verified group `/truong/hoc-vu`. */
export const EDUCATION_OFFICER = staffOf("truong", ["/truong/hoc-vu"]);

/** The coordinating unit with the bulletin-board group. */
export const COORDINATOR = staffOf("so-y-te", ["/so-y-te/ban-tin"], true);

/** The label matcher for a shared-UI field: the required marker sits inside the label text. */
export const fieldLabel = (label: string): RegExp =>
  new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`);

// ---------------------------------------------------------------- rendering

/** Renders a page under a pack context, as the app shell does after `GET /api/pack` answers. */
export const renderPack = (pack: PackProjection, ui: ReactElement) =>
  render(<PackContext.Provider value={{ pack, failed: false }}>{ui}</PackContext.Provider>);

/** Wraps children in the desk and pack contexts at once. */
export function renderDeskPack(pack: PackProjection, staff: DeskStaff, ui: ReactNode, api: unknown, signOut = () => {}): ReturnType<typeof render> {
  return render(
    <PackContext.Provider value={{ pack, failed: false }}>
      <DeskProvider staff={staff} api={api as never} signOut={signOut}>{ui}</DeskProvider>
    </PackContext.Provider>,
  );
}
