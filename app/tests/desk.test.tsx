// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import {
  CaseDetailPage,
  DESK_ROUTES,
  ExecutionsPage,
  OpenCasePage,
  deskPageFor,
  isDeskRoute,
  type DeskApi,
} from "../src/desk";
import { deskStrings as s } from "../src/desk/strings";
import { REFERENCE_PATTERN, generateReference } from "../src/pack/data";
import { EDUCATION_PACK, HEALTH_PACK, EDUCATION_OFFICER, HEALTH_NURSE, fieldLabel, renderDeskPack, staffOf } from "./helpers";

afterEach(() => { window.location.hash = ""; vi.restoreAllMocks(); });

// ---------------------------------------------------------------- fake DeskApi

interface PostCall {
  path: string;
  body: unknown;
  opts?: { idempotencyKey?: string };
}

interface ByteCall {
  path: string;
  file: Blob;
  headers: Record<string, string>;
}

const genericGet = (path: string): unknown => {
  if (path.includes("executions")) return { items: [] };
  if (path.includes("definitions")) return { items: [] };
  if (path.includes("bang-tin")) return { items: [] };
  if (path.includes("ghi-chu")) return { items: [] };
  if (path.includes("/tep")) return { items: [] };
  if (path.includes("organizations")) return { root: { id: "root", name: "Nền tảng", kind: "platform" } };
  if (path.includes("principals")) return { items: [] };
  if (path.includes("summary")) return { definitions: [], totals: { definitions: 0, running: 0, completed: 0, cancelled: 0 } };
  return {};
};

const makeApi = (options: {
  get?: (path: string) => unknown;
  post?: (path: string, body: unknown, opts?: { idempotencyKey?: string }) => unknown;
  bytes?: (path: string, file: Blob, headers: Record<string, string>) => unknown;
  blob?: (path: string) => Blob | Error;
}): { api: DeskApi; gets: string[]; posts: PostCall[]; bytesCalls: ByteCall[]; blobs: string[] } => {
  const gets: string[] = [];
  const posts: PostCall[] = [];
  const bytesCalls: ByteCall[] = [];
  const blobs: string[] = [];
  return {
    gets,
    posts,
    bytesCalls,
    blobs,
    api: {
      getJson: async path => {
        gets.push(path);
        const result = options.get?.(path) ?? genericGet(path);
        if (result instanceof Error) throw result;
        return result as never;
      },
      postJson: async (path, body, opts) => {
        posts.push({ path, body, opts });
        const result = options.post?.(path, body, opts);
        if (result instanceof Error) throw result;
        return (result ?? null) as never;
      },
      getBlob: async path => {
        blobs.push(path);
        const result = options.blob?.(path);
        if (result instanceof Error) throw result;
        return result as never;
      },
      postBytes: async (path, file, headers) => {
        bytesCalls.push({ path, file, headers });
        const result = options.bytes?.(path, file, headers);
        if (result instanceof Error) throw result;
        return result as never;
      },
    },
  };
};

// ---------------------------------------------------------------- engine fixtures

const STEP_VAN_THU = "Tiếp nhận hồ sơ";
const STEP_LANH_DAO = "Xét duyệt chuyển trường";

interface Fixture {
  id?: string;
  key?: string;
  name?: string;
  status?: "running" | "completed" | "cancelled";
  title?: string;
  groups?: string[];
  stepName?: string | null;
  updatedAt?: string;
}

const buildExecution = (fixture: Fixture = {}) => ({
  id: fixture.id ?? "11111111-1111-4111-8111-111111111111",
  definition: {
    id: fixture.key ?? "chuyentruong",
    key: fixture.key ?? "chuyentruong",
    name: fixture.name ?? "Chuyển trường",
    version: 1,
  },
  status: fixture.status ?? ("running" as const),
  startedAt: "2026-11-17T09:00:00Z",
  updatedAt: fixture.updatedAt ?? "2026-11-18T09:00:00Z",
  title: fixture.title ?? "CH-100001",
  currentStep: fixture.stepName === null ? null : {
    name: fixture.stepName ?? STEP_VAN_THU,
    assignee: null,
    groups: fixture.groups ?? ["van-thu"],
  },
});

const EXECUTIONS = [
  buildExecution({}),
  buildExecution({ id: "22222222-2222-4222-8222-222222222222", title: "CH-100002", stepName: STEP_LANH_DAO, groups: ["lanh-dao"] }),
];

const DEFINITIONS = {
  items: [
    { id: "def-ct", key: "chuyentruong", version: 2, name: "Chuyển trường" },
    { id: "def-hb", key: "capbansaohocba", version: 1, name: "Cấp bản sao học bạ" },
  ],
};

// ---------------------------------------------------------------- navigation frame

describe("space navigation", () => {
  it("groups the side menu as work, cases, then operations, without space letters", () => {
    expect(DESK_ROUTES.map(space => [space.path, space.label])).toEqual([
      ["/lam-viec", s.nav.work],
      ["/ho-so", s.nav.profile],
      ["/dieu-hanh", s.nav.operate],
    ]);
    for (const space of DESK_ROUTES) expect(space.label).not.toMatch(/^[HPD] ·/);
    expect(DESK_ROUTES[0].children.map(child => child.label)).toEqual([s.nav.today, s.nav.notices, s.nav.directory]);
    expect(DESK_ROUTES[1].children.map(child => child.label)).toEqual([s.nav.caseList, s.nav.openCase]);
  });

  it("tells desk routes apart from public routes", () => {
    for (const route of ["/lam-viec", "/lam-viec/bang-tin", "/ho-so", "/ho-so/mo", "/ho-so/11111111-1111-4111-8111-111111111111", "/dieu-hanh", "/dieu-hanh/x", "/dieu-phoi", "/dieu-phoi/ho-so"]) {
      expect(isDeskRoute(route)).toBe(true);
    }
    for (const route of ["/", "/hop-dong", "/quy-trinh", "/co-so", "/lam-viec-khac", "/ho-so-khac"]) {
      expect(isDeskRoute(route)).toBe(false);
    }
  });

  it("renders a page with a heading for every H and P route", async () => {
    const api = makeApi({});
    for (const route of ["/lam-viec", "/lam-viec/bang-tin", "/lam-viec/danh-ba", "/ho-so", "/ho-so/mo"]) {
      const { unmount } = renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, deskPageFor(route) as ReactElement, api.api);
      await screen.findByRole("heading", { level: 1 });
      unmount();
    }
  });

  it("hands every space D route to the D pages", () => {
    for (const route of ["/dieu-hanh", "/dieu-hanh/trao-doi", "/dieu-hanh/du-lieu", "/dieu-hanh/chia-se", "/dieu-hanh/bao-cao"]) {
      expect(deskPageFor(route)).not.toBeNull();
    }
  });

  it("returns null outside the desk routes", () => {
    for (const route of ["/", "/hop-dong", "/quy-trinh", "/co-so", "/dieu-phoi-khac"]) {
      expect(deskPageFor(route)).toBeNull();
    }
  });

  it("redirects the old desk routes to H (Hôm nay)", async () => {
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, deskPageFor("/dieu-phoi") as ReactElement, makeApi({}).api);
    await waitFor(() => expect(window.location.hash).toBe("#/lam-viec"));
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, deskPageFor("/dieu-phoi/ho-so") as ReactElement, makeApi({}).api);
    await waitFor(() => expect(window.location.hash).toBe("#/lam-viec"));
  });

  it("shows the not-found desk page for an unknown desk route", () => {
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, deskPageFor("/lam-viec/khong-co") as ReactElement, makeApi({}).api);
    expect(screen.getByText(s.errors.notFoundPage)).toBeTruthy();
    expect(screen.getByRole("link", { name: s.errors.notFoundPageAction }).getAttribute("href")).toBe("#/lam-viec");
  });
});

// ---------------------------------------------------------------- cases list (P · Danh sách)

describe("cases list page", () => {
  it("shows the pack cases with code, workflow, status, step and acting groups", async () => {
    const api = makeApi({ get: () => ({ items: EXECUTIONS }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <ExecutionsPage />, api.api);
    expect(api.gets).toEqual(["/v1/workflows/executions?limit=100"]);
    await screen.findByText("CH-100001");
    expect(screen.getByText("CH-100002")).toBeTruthy();
    const row = screen.getByText("CH-100002").closest("tr")!;
    expect(row.textContent).toContain(STEP_LANH_DAO);
    expect(row.textContent).toContain("Lãnh đạo đơn vị");
  });

  it("keeps only the workflows the installed pack declares", async () => {
    const api = makeApi({ get: () => ({ items: [buildExecution({ key: "quy-trinh-le", title: "ZZ-000001" }), ...EXECUTIONS] }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <ExecutionsPage />, api.api);
    await screen.findByText("CH-100001");
    expect(screen.queryByText("ZZ-000001")).toBeNull();
  });

  it("filters to the cases waiting at the staff's groups with the toggle", async () => {
    const api = makeApi({ get: () => ({ items: EXECUTIONS }) });
    const clerk = staffOf("truong", ["/truong/hoc-vu", "/truong/van-thu"]);
    renderDeskPack(EDUCATION_PACK, clerk, <ExecutionsPage />, api.api);
    await screen.findByText("CH-100002");
    fireEvent.click(screen.getByLabelText(s.cases.mineOnly));
    expect(screen.queryByText("CH-100002")).toBeNull();
    expect(screen.getByText("CH-100001")).toBeTruthy();
    fireEvent.click(screen.getByLabelText(s.cases.mineOnly));
    await screen.findByText("CH-100002");
  });

  it("links to the moved open-case and detail routes", async () => {
    const api = makeApi({ get: () => ({ items: EXECUTIONS }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <ExecutionsPage />, api.api);
    await screen.findByText("CH-100001");
    expect(screen.getByRole("link", { name: s.cases.openCase }).getAttribute("href")).toBe("#/ho-so/mo");
    expect(screen.getByRole("link", { name: "CH-100001" }).getAttribute("href")).toBe("#/ho-so/11111111-1111-4111-8111-111111111111");
  });

  it("renders the 403 message as plain Vietnamese", async () => {
    const api = makeApi({ get: () => Object.assign(new Error("api"), { status: 403, code: null }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <ExecutionsPage />, api.api);
    await screen.findByText(s.errors.forbidden);
  });
});

// ---------------------------------------------------------------- open case (P · Mở hồ sơ)

describe("open case page", () => {
  it("offers the workflows the staff's verified groups may open and posts the pack's open form", async () => {
    const api = makeApi({ get: () => ({ items: DEFINITIONS.items }), post: () => ({ id: "66666666-6666-4666-8666-666666666666" }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <OpenCasePage />, api.api);
    expect(api.gets).toEqual(["/v1/workflows/definitions"]);
    await screen.findByText(s.openCase.submit);
    const select = screen.getByLabelText(s.openCase.workflow) as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(["chuyentruong", "capbansaohocba"]);
    const reference = (screen.getByLabelText(s.openCase.reference) as HTMLInputElement).value;
    expect(reference).toMatch(REFERENCE_PATTERN);
    expect((screen.getByLabelText(fieldLabel("Họ tên học sinh")) as HTMLInputElement).value).toBe("");
    fireEvent.change(screen.getByLabelText(fieldLabel("Họ tên học sinh")), { target: { value: "Nguyễn Văn B" } });
    fireEvent.change(screen.getByLabelText(fieldLabel("Lớp hiện tại")), { target: { value: "5A" } });
    fireEvent.change(screen.getByLabelText(fieldLabel("Trường muốn chuyển đến")), { target: { value: "Trường Bắc" } });
    fireEvent.click(screen.getByRole("button", { name: s.openCase.submit }));
    await waitFor(() => expect(api.posts).toHaveLength(1));
    expect(api.posts[0].path).toBe("/v1/workflows/executions");
    expect(api.posts[0].body).toEqual({
      definitionId: "def-ct",
      input: { reference, openedBy: "truong", "ho-ten-hoc-sinh": "Nguyễn Văn B", "lop-hien-tai": "5A", "truong-chuyen-den": "Trường Bắc" },
    });
    expect(api.posts[0].opts?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    await waitFor(() => expect(window.location.hash).toBe("#/ho-so/66666666-6666-4666-8666-666666666666"));
  });

  it("blocks the submit while a required pack field is empty", async () => {
    const api = makeApi({ get: () => ({ items: DEFINITIONS.items }), post: () => ({ id: "x" }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <OpenCasePage />, api.api);
    await screen.findByText(s.openCase.submit);
    fireEvent.click(screen.getByRole("button", { name: s.openCase.submit }));
    await screen.findByRole("alert");
    expect(screen.getByText(s.openCase.requiredEmpty)).toBeTruthy();
    expect(api.posts).toHaveLength(0);
  });

  it("blocks an invalid reference code", async () => {
    const api = makeApi({ get: () => ({ items: DEFINITIONS.items }), post: () => ({ id: "x" }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <OpenCasePage />, api.api);
    await screen.findByText(s.openCase.submit);
    fireEvent.change(screen.getByLabelText(s.openCase.reference), { target: { value: "ct-123" } });
    fireEvent.click(screen.getByRole("button", { name: s.openCase.submit }));
    await screen.findByRole("alert");
    expect(screen.getByText(s.openCase.referenceInvalid)).toBeTruthy();
    expect(api.posts).toHaveLength(0);
  });

  it("keeps the same idempotency key when the staff clicks again after a failure", async () => {
    const api = makeApi({
      get: () => ({ items: DEFINITIONS.items }),
      post: () => Object.assign(new Error("api"), { status: 503, code: "engine_unavailable" }),
    });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <OpenCasePage />, api.api);
    await screen.findByText(s.openCase.submit);
    fireEvent.change(screen.getByLabelText(fieldLabel("Họ tên học sinh")), { target: { value: "Nguyễn Văn B" } });
    fireEvent.change(screen.getByLabelText(fieldLabel("Lớp hiện tại")), { target: { value: "5A" } });
    fireEvent.change(screen.getByLabelText(fieldLabel("Trường muốn chuyển đến")), { target: { value: "Trường Bắc" } });
    fireEvent.click(screen.getByRole("button", { name: s.openCase.submit }));
    await waitFor(() => expect(api.posts).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: s.openCase.submit }));
    await waitFor(() => expect(api.posts).toHaveLength(2));
    expect(api.posts[0].opts?.idempotencyKey).toBeTruthy();
    expect(api.posts[0].opts?.idempotencyKey).toBe(api.posts[1].opts?.idempotencyKey);
  });

  it("shows the empty state when no pack workflow is openable by the staff's groups", async () => {
    const api = makeApi({});
    renderDeskPack(EDUCATION_PACK, staffOf("phong-giao-duc", ["/phong-giao-duc/van-thu"]), <OpenCasePage />, api.api);
    await screen.findByText(s.openCase.noWorkflow);
    expect(screen.queryByRole("button", { name: s.openCase.submit })).toBeNull();
  });

  it("renders the 403 message when the staff may not open a case", async () => {
    const api = makeApi({ get: () => Object.assign(new Error("api"), { status: 403, code: null }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <OpenCasePage />, api.api);
    await screen.findByText(s.errors.forbidden);
  });

  it("renders the health pack's open form with its own fields from the same component", async () => {
    const api = makeApi({ get: () => ({ items: [{ id: "def-ct", key: "chuyen-tuyen", version: 1, name: "Chuyển tuyến" }] }), post: () => ({ id: "y" }) });
    renderDeskPack(HEALTH_PACK, staffOf("phong-kham", ["/phong-kham/bac-si"]), <OpenCasePage />, api.api);
    await screen.findByText(s.openCase.submit);
    const select = screen.getByLabelText(s.openCase.workflow) as HTMLSelectElement;
    expect([...select.options].map(option => option.value)).toEqual(["chuyen-tuyen"]);
    expect(screen.getByLabelText(fieldLabel("Lý do chuyển tuyến"))).toBeTruthy();
    const urgency = screen.getByLabelText(fieldLabel("Mức ưu tiên")) as HTMLSelectElement;
    expect([...urgency.options].map(option => option.textContent)).toEqual(["—", "Cấp cứu", "Khẩn", "Thường"]);
    expect(screen.queryByLabelText("Họ tên học sinh")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: s.openCase.submit }));
    await screen.findByText(s.openCase.requiredEmpty);
    fireEvent.change(screen.getByLabelText(fieldLabel("Lý do chuyển tuyến")), { target: { value: "Cần phẫu thuật." } });
    fireEvent.change(urgency, { target: { value: "Khẩn" } });
    fireEvent.click(screen.getByRole("button", { name: s.openCase.submit }));
    await waitFor(() => expect(api.posts).toHaveLength(1));
    expect((api.posts[0].body as { input: Record<string, unknown> }).input).toMatchObject({
      openedBy: "phong-kham", "ly-do-chuyen-tuyen": "Cần phẫu thuật.", "muc-uu-tien": "Khẩn",
    });
  });
});

// ---------------------------------------------------------------- case detail (P · Chi tiết)

const DETAIL_ID = "77777777-7777-4777-8777-777777777777";
const DETAIL = {
  id: DETAIL_ID,
  definitionId: "def-ct",
  status: "running",
  input: {
    reference: "CH-123456",
    openedBy: "truong",
    "ho-ten-hoc-sinh": "Nguyễn Văn B",
    "lop-hien-tai": "5A",
    "truong-chuyen-den": "Trường Bắc",
  },
};
const DETAIL_LIST = { items: [buildExecution({ id: DETAIL_ID, title: "CH-123456", stepName: STEP_LANH_DAO, groups: ["lanh-dao"] })] };

const COORDINATOR_STAFF = staffOf("so-y-te", ["/so-y-te/ban-tin"], true);

const detailOrCases = (path: string): unknown => {
  if (path.includes("/ghi-chu")) return { items: [] };
  if (path.includes("/tep")) return { items: [] };
  return path.includes(DETAIL_ID) ? DETAIL : DETAIL_LIST;
};

describe("case detail page", () => {
  it("draws the pack workflow steps with progress and the acting groups", async () => {
    const api = makeApi({ get: detailOrCases });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
    expect(api.gets.slice(0, 2)).toEqual([`/v1/workflows/executions/${DETAIL_ID}`, "/v1/workflows/executions?limit=100"]);
    await screen.findAllByText("CH-123456");
    expect(within(screen.getByRole("main")).getAllByText("Nguyễn Văn B").length).toBe(1); // pack field of the input
    expect(within(screen.getByRole("main")).getAllByText("Văn thư").length).toBeGreaterThan(0);
    expect(screen.getByText(s.detail.stepCurrent)).toBeTruthy();
    expect(screen.getAllByText(s.detail.stepFuture).length).toBeGreaterThan(0);
  });

  it("shows the opener's input with the pack's field labels", async () => {
    const api = makeApi({ get: detailOrCases });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText(s.detail.form.title);
    expect(screen.getByText("Họ tên học sinh")).toBeTruthy();
    expect(screen.getByText("Trường muốn chuyển đến").nextElementSibling?.textContent).toBe("Trường Bắc");
  });

  it("shows the complete button only to the group of the current step", async () => {
    const api = makeApi({ get: detailOrCases });
    const officer = staffOf("phong-giao-duc", ["/phong-giao-duc/lanh-dao"]);
    const { unmount } = renderDeskPack(EDUCATION_PACK, officer, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByRole("button", { name: `Hoàn tất bước ${STEP_LANH_DAO}` });
    unmount();
  });

  it("hides the complete button for other groups and tells them the view is read-only", async () => {
    const api = makeApi({ get: detailOrCases });
    renderDeskPack(EDUCATION_PACK, HEALTH_NURSE, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findAllByText("CH-123456");
    expect(screen.queryByRole("button", { name: new RegExp(s.detail.completeStep) })).toBeNull();
    expect(screen.getByText(s.detail.readonly)).toBeTruthy();
  });

  it("completes the current step after confirmation and reloads", async () => {
    const api = makeApi({ get: detailOrCases, post: () => ({}) });
    renderDeskPack(EDUCATION_PACK, staffOf("phong-giao-duc", ["/phong-giao-duc/lanh-dao"]), <CaseDetailPage id={DETAIL_ID} />, api.api);
    fireEvent.click(await screen.findByRole("button", { name: `Hoàn tất bước ${STEP_LANH_DAO}` }));
    fireEvent.click(await screen.findByRole("button", { name: s.detail.confirmLabel }));
    await waitFor(() => expect(api.posts).toHaveLength(1));
    expect(api.posts[0].path).toBe(`/v1/workflows/executions/${DETAIL_ID}/complete`);
    expect(api.posts[0].body).toEqual({});
    await waitFor(() => expect(api.gets.length).toBe(6));
  });

  it("links back to the moved case list", async () => {
    const api = makeApi({ get: detailOrCases });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText(s.detail.form.title);
    expect(screen.getByRole("link", { name: `← ${s.detail.backToList}` }).getAttribute("href")).toBe("#/ho-so");
  });

  it("renders the 403 message when completing is not allowed", async () => {
    const api = makeApi({ get: () => Object.assign(new Error("api"), { status: 403, code: null }) });
    renderDeskPack(EDUCATION_PACK, staffOf("phong-giao-duc", ["/phong-giao-duc/lanh-dao"]), <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText(s.errors.forbidden);
  });

  it("renders the 404 message for a missing case", async () => {
    const api = makeApi({ get: () => Object.assign(new Error("api"), { status: 404, code: null }) });
    renderDeskPack(EDUCATION_PACK, COORDINATOR_STAFF, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText(s.errors.notFound);
  });
});

// ---------------------------------------------------------------- notes and attachments (P · Chi tiết)

const noteOrCases = (path: string): unknown => {
  if (path.includes("/ghi-chu")) return { items: [{ id: "note-1", executionId: DETAIL_ID, text: "Ghi chú đầu.", author: { displayName: "Trường học", facility: "truong" }, createdAt: "2026-11-18T08:00:00Z" }] };
  if (path.includes("/tep")) return { items: [] };
  return detailOrCases(path);
};

describe("case notes", () => {
  it("reads the notes of the gateway and posts a new one at the end", async () => {
    const api = makeApi({ get: noteOrCases, post: () => ({ id: "note-2", executionId: DETAIL_ID, text: "Ghi chú mới.", author: { displayName: "Nguyễn Văn A", facility: "truong" }, createdAt: "2026-11-18T09:00:00Z" }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText("Ghi chú đầu.");
    expect(api.gets).toContain(`/api/ho-so/${DETAIL_ID}/ghi-chu`);
    fireEvent.change(screen.getByLabelText(s.detail.notes.input), { target: { value: "Ghi chú mới." } });
    fireEvent.click(screen.getByRole("button", { name: s.detail.notes.submit }));
    await waitFor(() => expect(api.posts).toHaveLength(1));
    expect(api.posts[0].path).toBe(`/api/ho-so/${DETAIL_ID}/ghi-chu`);
    expect(api.posts[0].body).toEqual({ text: "Ghi chú mới." });
    await screen.findByText("Ghi chú mới.");
    expect(screen.getAllByText("Ghi chú đầu.").length).toBe(1);
  });

  it("keeps the note when the gateway returns nothing and reloads instead", async () => {
    const api = makeApi({ get: noteOrCases, post: () => null });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText("Ghi chú đầu.");
    fireEvent.change(screen.getByLabelText(s.detail.notes.input), { target: { value: "Ghi chú mới." } });
    fireEvent.click(screen.getByRole("button", { name: s.detail.notes.submit }));
    await waitFor(() => expect(api.posts).toHaveLength(1));
    await waitFor(() => expect(api.gets.filter(path => path.includes("/ghi-chu")).length).toBe(2));
  });

  it("shows a plain Vietnamese failure when posting is refused", async () => {
    const api = makeApi({ get: noteOrCases, post: () => Object.assign(new Error("api"), { status: 403, code: null }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText("Ghi chú đầu.");
    fireEvent.change(screen.getByLabelText(s.detail.notes.input), { target: { value: "Ghi chú mới." } });
    fireEvent.click(screen.getByRole("button", { name: s.detail.notes.submit }));
    await screen.findByText(s.detail.notes.failed);
  });
});

// ---------------------------------------------------------------- attachments (P · Tệp đính kèm)

const fileBlob = (options: { type: string; name: string; size?: number }): File => {
  const bytes = new Uint8Array(options.size ?? 10);
  return new File([bytes], options.name, { type: options.type });
};

const fileOrCases = (path: string): unknown => {
  if (path.includes("/tep")) return { items: [{ id: "file-1", executionId: DETAIL_ID, name: "hoso.pdf", type: "application/pdf", bytes: 12, author: { displayName: "Trường học", facility: "truong" }, createdAt: "2026-11-18T08:00:00Z" }] };
  return detailOrCases(path);
};

describe("case attachments", () => {
  it("lists the attachments of the case", async () => {
    const api = makeApi({ get: fileOrCases });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText("hoso.pdf");
    expect(api.gets).toContain(`/api/ho-so/${DETAIL_ID}/tep`);
  });

  it("blocks a wrong file kind and an oversized file before sending anything", async () => {
    const api = makeApi({ get: fileOrCases });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText("hoso.pdf");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fileBlob({ type: "text/plain", name: "ghi-chu.txt" })] } });
    fireEvent.click(screen.getByRole("button", { name: s.detail.files.submit }));
    await screen.findByText(s.detail.files.wrongType);
    expect(api.bytesCalls).toHaveLength(0);
    fireEvent.change(input, { target: { files: [fileBlob({ type: "application/pdf", name: "to.pdf", size: 5 * 1024 * 1024 + 1 })] } });
    fireEvent.click(screen.getByRole("button", { name: s.detail.files.submit }));
    await screen.findByText(s.detail.files.tooLarge);
    expect(api.bytesCalls).toHaveLength(0);
  });

  it("sends the raw bytes with Content-Type and X-File-Name headers", async () => {
    const api = makeApi({ get: fileOrCases, bytes: () => ({ id: "file-2", executionId: DETAIL_ID, name: "hoso.pdf", type: "application/pdf", bytes: 10, author: { displayName: "Nguyễn Văn A", facility: "truong" }, createdAt: "2026-11-18T09:00:00Z" }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText("hoso.pdf");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fileBlob({ type: "application/pdf", name: "hoso.pdf" })] } });
    fireEvent.click(screen.getByRole("button", { name: s.detail.files.submit }));
    await waitFor(() => expect(api.bytesCalls).toHaveLength(1));
    expect(api.bytesCalls[0].path).toBe(`/api/ho-so/${DETAIL_ID}/tep`);
    expect(api.bytesCalls[0].headers["Content-Type"]).toBe("application/pdf");
    expect(api.bytesCalls[0].headers["X-File-Name"]).toBe(encodeURIComponent("hoso.pdf"));
    expect(api.bytesCalls[0].file.size).toBe(10);
    await waitFor(() => expect(api.gets.filter(path => path.includes("/tep")).length).toBe(2));
  });

  it("tells a malware detection in plain Vietnamese on 422", async () => {
    const api = makeApi({ get: fileOrCases, bytes: () => Object.assign(new Error("api"), { status: 422, code: "malware_detected" }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText("hoso.pdf");
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [fileBlob({ type: "image/png", name: "anh.png" })] } });
    fireEvent.click(screen.getByRole("button", { name: s.detail.files.submit }));
    await screen.findByText(s.detail.files.malware);
    expect(api.gets.filter(path => path.includes("/tep")).length).toBe(1);
  });

  it("downloads an attachment through getBlob", async () => {
    const url = URL.createObjectURL?.(new Blob()) ?? "blob:fake";
    const createObjectURL = vi.fn(() => url);
    const revokeObjectURL = vi.fn();
    const originalCreate = URL.createObjectURL;
    const originalRevoke = URL.revokeObjectURL;
    URL.createObjectURL = createObjectURL as unknown as typeof URL.createObjectURL;
    URL.revokeObjectURL = revokeObjectURL as unknown as typeof URL.revokeObjectURL;
    try {
      const api = makeApi({ get: fileOrCases, blob: () => new Blob(["pdf"], { type: "application/pdf" }) });
      renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
      await screen.findByText("hoso.pdf");
      fireEvent.click(screen.getByRole("button", { name: s.detail.files.download }));
      await waitFor(() => expect(api.blobs).toEqual(["/api/tep/file-1"]));
      await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
      await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith(url));
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });

  it("shows a download failure in plain Vietnamese", async () => {
    const api = makeApi({ get: fileOrCases, blob: () => Object.assign(new Error("api"), { status: 404, code: null }) });
    renderDeskPack(EDUCATION_PACK, EDUCATION_OFFICER, <CaseDetailPage id={DETAIL_ID} />, api.api);
    await screen.findByText("hoso.pdf");
    fireEvent.click(screen.getByRole("button", { name: s.detail.files.download }));
    await screen.findByText(s.detail.files.downloadFailed);
  });
});

// ---------------------------------------------------------------- two-unit session

describe("a staff member of two units acts only through the selected unit", () => {
  // Verified membership: nurse at `benh-vien`, plus a pharmacist group that
  // belongs to the other unit `phong-kham`. Bare group-suffix matching would
  // grant the pharmacy rights; matching against the selected unit must not.
  const TWO_UNIT = staffOf("benh-vien", ["/benh-vien/y-ta", "/phong-kham/bac-si"]);

  it("does not open the workflows whose open role the other unit's group carries", async () => {
    const api = makeApi({ get: () => ({ items: [{ id: "def-ct", key: "chuyen-tuyen", version: 1, name: "Chuyển tuyến" }] }) });
    renderDeskPack(HEALTH_PACK, TWO_UNIT, <OpenCasePage />, api.api);
    await screen.findByText(s.openCase.noWorkflow);
    expect(screen.queryByRole("button", { name: s.openCase.submit })).toBeNull();
  });

  it("does not count a case waiting at the other unit's group as its own", async () => {
    const waiting = buildExecution({ key: "chuyen-tuyen", name: "Chuyển tuyến", title: "CT-100001", stepName: "Khám và chỉ định", groups: ["bac-si"] });
    const api = makeApi({ get: () => ({ items: [waiting] }) });
    renderDeskPack(HEALTH_PACK, TWO_UNIT, <ExecutionsPage />, api.api);
    await screen.findByText("CT-100001");
    fireEvent.click(screen.getByLabelText(s.cases.mineOnly));
    expect(screen.queryByText("CT-100001")).toBeNull();
    fireEvent.click(screen.getByLabelText(s.cases.mineOnly));
    await screen.findByText("CT-100001");
  });

  it("keeps the rights of the selected unit's own group", async () => {
    const api = makeApi({ get: () => ({ items: [{ id: "def-ct", key: "thanh-toan", version: 1, name: "Thanh toán" }] }) });
    // thanh-toan is opened by `tai-chinh`; a two-unit member without it still sees nothing.
    renderDeskPack(HEALTH_PACK, TWO_UNIT, <OpenCasePage />, api.api);
    await screen.findByText(s.openCase.noWorkflow);
    const finance = staffOf("benh-vien", ["/benh-vien/tai-chinh"]);
    const api2 = makeApi({ get: () => ({ items: [{ id: "def-tt", key: "thanh-toan", version: 1, name: "Thanh toán" }] }) });
    const second = renderDeskPack(HEALTH_PACK, finance, <OpenCasePage />, api2.api);
    await screen.findByText(s.openCase.submit);
    expect(screen.getByRole("button", { name: s.openCase.submit })).toBeTruthy();
    second.unmount();
  });
});

// ---------------------------------------------------------------- pure helpers of the pack module

describe("reference codes", () => {
  it("derives the prefix from the pack workflow id and generates matching codes", () => {
    expect(generateReference("CH-")).toMatch(/^CH-[A-Z0-9]{6}$/);
    expect(generateReference("CA-")).toMatch(/^CA-[A-Z0-9]{6}$/);
  });
});
