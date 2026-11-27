// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordTypeCatalog, recordTypeDetail } from "../src/catalog";
import { RecordTypeDetailPage, RecordTypesPage, SPACE_ROUTES, UnitsPage, WorkflowsPage } from "../src/space";
import { spaceStrings as s } from "../src/space/strings";
import { EDUCATION_PACK, HEALTH_PACK, renderPack, workflowOf } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

describe("workflow diagrams projected from the canonical packs", () => {
  it("keeps every business node with the acting groups, in document order", () => {
    for (const pack of [EDUCATION_PACK, HEALTH_PACK]) {
      for (const workflow of pack.workflows) {
        expect(workflow.diagram.nodes[0]?.kind).toBe("start");
        expect(workflow.diagram.nodes.at(-1)?.kind).toBe("end");
        for (const node of workflow.diagram.nodes) {
          expect(["start", "task", "gateway", "end"]).toContain(node.kind);
          if (node.kind === "task") {
            expect(node.name.length).toBeGreaterThan(0);
            expect(node.groups?.length ?? 0).toBeGreaterThan(0);
          }
        }
      }
    }
    expect(workflowOf(HEALTH_PACK, "chuyen-tuyen").diagram.nodes.find(node => node.id === "tiep-nhan-benh-nhan")?.groups).toEqual(["y-ta"]);
    expect(workflowOf(EDUCATION_PACK, "chuyentruong").diagram.nodes.find(node => node.id === "tiep-nhan-ho-so")?.groups).toEqual(["van-thu"]);
  });

  it("preserves every edge, including the two rejection routes of the education transfer", () => {
    const transfer = workflowOf(EDUCATION_PACK, "chuyentruong");
    expect(transfer.diagram.nodes.map(node => node.kind)).toEqual(["start", "task", "gateway", "task", "gateway", "task", "end", "end", "end"]);
    const intake = transfer.diagram.edges.filter(edge => edge.from === "quyet-dinh-tiep-nhan");
    expect(intake.map(edge => edge.to)).toEqual(["xet-duyet", "end-tu-choi-tiep-nhan"]);
    expect(intake.map(edge => edge.label)).toEqual(["Tiếp nhận hồ sơ", "Từ chối tiếp nhận"]);
    const review = transfer.diagram.edges.filter(edge => edge.from === "quyet-dinh-xet-duyet");
    expect(review.map(edge => edge.label)).toEqual(["Chấp nhận chuyển trường", "Không chấp nhận"]);
    expect(JSON.stringify(EDUCATION_PACK)).not.toContain("decision ==");
  });

  it("walks the happy path from the start event for progress displays", () => {
    expect(workflowOf(EDUCATION_PACK, "chuyentruong").diagram.path).toEqual([
      "start", "tiep-nhan-ho-so", "quyet-dinh-tiep-nhan", "xet-duyet", "quyet-dinh-xet-duyet", "thong-bao-ket-qua", "end",
    ]);
    expect(workflowOf(HEALTH_PACK, "chuyen-tuyen").diagram.path).toEqual([
      "start", "tiep-nhan-benh-nhan", "kham-va-chi-dinh", "phan-hoi-ket-qua", "end",
    ]);
  });

  it("diverges for the health pack: a linear flow with unlabelled edges and no gateways", () => {
    const referral = workflowOf(HEALTH_PACK, "chuyen-tuyen");
    expect(referral.diagram.nodes.map(node => node.kind)).toEqual(["start", "task", "task", "task", "end"]);
    expect(referral.diagram.edges.every(edge => edge.label == null)).toBe(true);
  });
});

describe("case-type catalog", () => {
  it("lists each pack's record types with their workflow counts", () => {
    expect(recordTypeCatalog(EDUCATION_PACK).map(entry => entry.id)).toEqual(["chuyen-truong", "cap-ban-sao-hoc-ba"]);
    expect(recordTypeCatalog(EDUCATION_PACK).map(entry => entry.workflowCount)).toEqual([1, 1]);
    expect(recordTypeCatalog(HEALTH_PACK).map(entry => entry.id)).toEqual(["chuyen-tuyen", "thanh-toan"]);
    expect(recordTypeCatalog(HEALTH_PACK).map(entry => entry.name)).toEqual(["Hồ sơ chuyển tuyến", "Hồ sơ thanh toán"]);
  });

  it("builds the library detail with diagram, forms, groups and SLA", () => {
    const detail = recordTypeDetail(EDUCATION_PACK, "chuyen-truong")!;
    expect(detail.workflows).toHaveLength(1);
    const view = detail.workflows[0];
    expect(view.diagram.path).toEqual([
      "start", "tiep-nhan-ho-so", "quyet-dinh-tiep-nhan", "xet-duyet", "quyet-dinh-xet-duyet", "thong-bao-ket-qua", "end",
    ]);
    expect(view.openFields.map(field => field.id)).toEqual(["ho-ten-hoc-sinh", "lop-hien-tai", "truong-chuyen-den"]);
    expect(view.steps.map(step => step.deadlineDays)).toEqual([2, 5, 3]);
    expect(view.steps[0].decisions.map(decision => decision.outcome)).toEqual(["approve", "reject"]);
    expect(view.steps[0].decisions[1].requiresReason).toBe(true);
    expect(view.workflow.senderGroups).toEqual(["hoc-vu"]);
    expect(view.workflow.receiverGroups).toEqual(["van-thu", "lanh-dao", "hoc-vu"]);
  });

  it("gives no detail for an id the pack does not declare", () => {
    expect(recordTypeDetail(EDUCATION_PACK, "khong-ton-tai")).toBeUndefined();
  });
});

describe("record types list page", () => {
  it("shows every record type of the served pack as a card linking to its detail route", () => {
    renderPack(EDUCATION_PACK, <RecordTypesPage />);
    for (const entry of recordTypeCatalog(EDUCATION_PACK)) {
      const link = document.querySelector<HTMLAnchorElement>(`a[href="#/hop-dong/${entry.id}"]`);
      expect(link?.textContent).toContain(entry.name);
    }
    expect(screen.getByRole("heading", { name: s.types.title })).toBeTruthy();
  });

  it("shows the other pack's record types from the same page component", () => {
    renderPack(HEALTH_PACK, <RecordTypesPage />);
    expect(screen.getByText("Hồ sơ chuyển tuyến")).toBeTruthy();
    expect(screen.queryByText("Hồ sơ chuyển trường")).toBeNull();
  });
});

describe("record type detail page", () => {
  it("shows the diagram, open form, step forms, SLA and allowed groups", () => {
    const view = renderPack(EDUCATION_PACK, <RecordTypeDetailPage slug="chuyen-truong" />);
    expect(screen.getByRole("heading", { name: "Hồ sơ chuyển trường", level: 1 })).toBeTruthy();
    expect(screen.getAllByText("Tiếp nhận hồ sơ").length).toBeGreaterThan(1); // diagram step, form caption and decision share the label
    expect(screen.getAllByText("Xét duyệt chuyển trường").length).toBeGreaterThan(1);
    expect(screen.getAllByText("Họ tên học sinh").length).toBeGreaterThan(0);
    expect(view.container.textContent).toContain(`Hạn xử lý: 5 ${s.type.slaDays}`);
    expect(screen.getAllByText("Học vụ").length).toBeGreaterThan(0);
    expect(screen.getByText("Văn thư")).toBeTruthy();
    expect(screen.getByText("Lãnh đạo đơn vị")).toBeTruthy();
    expect(screen.getByText("Phòng Giáo dục")).toBeTruthy();
    // Both gateway outcomes of the transfer flow stay visible, with the
    // user-facing decision labels resolved from the manifest.
    expect(screen.getAllByText("Từ chối tiếp nhận").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Không chấp nhận").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Chấp nhận chuyển trường").length).toBeGreaterThan(0);
  });

  it("renders the health pack's record type from the same component", () => {
    const view = renderPack(HEALTH_PACK, <RecordTypeDetailPage slug="chuyen-tuyen" />);
    expect(screen.getAllByText("Tiếp nhận bệnh nhân").length).toBeGreaterThan(1); // diagram step, form caption and decision share the label
    expect(screen.getAllByText("Y tá").length).toBeGreaterThan(0);
    expect(view.container.textContent).toContain("Chuyển tuyến trên"); // a select option of the pack's own form
    expect(screen.queryByText("Hồ sơ chuyển trường")).toBeNull();
  });

  it("falls back to a not-found state for an unknown id", () => {
    renderPack(EDUCATION_PACK, <RecordTypeDetailPage slug="khong-ton-tai" />);
    expect(screen.getByText(s.type.notFoundTitle)).toBeTruthy();
    expect(screen.getByText(s.type.notFoundLead)).toBeTruthy();
    expect(screen.getByRole("button", { name: s.type.backToList })).toBeTruthy();
  });
});

describe("workflows page", () => {
  it("lists the pack workflows with numbered steps and acting groups", () => {
    renderPack(HEALTH_PACK, <WorkflowsPage />);
    for (const workflow of HEALTH_PACK.workflows) {
      expect(screen.getByRole("heading", { name: workflow.name })).toBeTruthy();
    }
    expect(screen.getByText(`Nhóm thực hiện: Y tá`)).toBeTruthy();
    expect(screen.getAllByText(`Nhóm thực hiện: Bác sĩ`).length).toBe(2);
    expect(screen.getAllByText(`Nhóm thực hiện: Tài chính`).length).toBe(1);
  });

  it("renders the education pack instead from the same component", () => {
    renderPack(EDUCATION_PACK, <WorkflowsPage />);
    expect(screen.getByText(`Nhóm thực hiện: Văn thư`)).toBeTruthy();
    expect(screen.queryByText(`Nhóm thực hiện: Y tá`)).toBeNull();
  });
});

describe("units page", () => {
  it("shows every unit type with the workflows it opens and receives", () => {
    renderPack(HEALTH_PACK, <UnitsPage />);
    for (const unitType of HEALTH_PACK.unitTypes) {
      expect(screen.getByRole("heading", { name: unitType.name })).toBeTruthy();
    }
    expect(screen.getAllByRole("link", { name: "Chuyển tuyến" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("link", { name: "Thanh toán" }).length).toBeGreaterThan(0);
  });
});

describe("routes", () => {
  it("exposes the three space routes", () => {
    expect(SPACE_ROUTES.map(route => route.path)).toEqual(["/hop-dong", "/quy-trinh", "/co-so"]);
    for (const route of SPACE_ROUTES) expect(route.label.length).toBeGreaterThan(0);
  });
});

describe("no network", () => {
  it("no library page calls fetch", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderPack(EDUCATION_PACK, <RecordTypesPage />);
    renderPack(EDUCATION_PACK, <WorkflowsPage />);
    renderPack(EDUCATION_PACK, <UnitsPage />);
    for (const entry of recordTypeCatalog(EDUCATION_PACK)) renderPack(EDUCATION_PACK, <RecordTypeDetailPage slug={entry.id} />);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
