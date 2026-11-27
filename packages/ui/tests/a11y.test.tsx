// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import { AppShell, Badge, Card, DataTable, DisplayPrefsProvider, EmptyState, ErrorState, LandingPage, PreviewFrame, SignInPage, Skeleton, StatCard, Tabs, TextField, Timeline } from "../src";

async function violations(node: HTMLElement) {
  // color-contrast needs real layout, which jsdom lacks: covered by contrast.test.ts.
  const result = await axe.run(node, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
  return result.violations.map(violation => `${violation.id}: ${violation.nodes.map(item => item.html).join(" | ")}`);
}

describe("axe", () => {
  it("landing page", async () => {
    const { container } = render(<LandingPage product="Workspace" headline="Hồ sơ" lead="Mô tả" onSignIn={() => {}} benefits={{ title: "Lợi ích", items: [{ title: "A", text: "a" }, { title: "B", text: "b" }] }} steps={{ title: "Cách dùng", items: [{ title: "Một", text: "x" }] }} faq={{ title: "Hỏi đáp", items: [{ q: "Câu hỏi?", a: "Trả lời." }] }} cta={{ title: "Bắt đầu" }} hero={<PreviewFrame label="Minh hoạ">x</PreviewFrame>} footer={{ links: [{ label: "GitHub", href: "https://example.org" }] }} />, { wrapper: DisplayPrefsProvider });
    expect(await violations(container)).toEqual([]);
  });
  it("sign-in page", async () => {
    const { container } = render(<SignInPage product="Workspace" subtitle="Đăng nhập" onSignIn={() => {}} onBack={() => {}} message="Phiên đã hết hạn" />, { wrapper: DisplayPrefsProvider });
    expect(await violations(container)).toEqual([]);
  });
  it("app shell with content", async () => {
    const { container } = render(
      <DisplayPrefsProvider>
        <AppShell product="Workspace" nav={[{ id: "a", label: "Hồ sơ" }, { id: "b", label: "Lịch" }]} current="a" onNavigate={() => {}} user={{ name: "NV A", role: "Biên tập" }} onSignOut={() => {}}>
          <Tabs label="Hồ sơ" value="a" onChange={() => {}} items={[{ id: "a", label: "Tổng quan" }, { id: "b", label: "Chi tiết" }]} />
          <Card title="Chi tiết" count={1}><Badge tone="ok">Sẵn sàng</Badge></Card>
        </AppShell>
      </DisplayPrefsProvider>,
    );
    expect(await violations(container)).toEqual([]);
  });
  it("states and forms", async () => {
    const { container } = render(
      <div>
        <EmptyState title="Trống" />
        <ErrorState onRetry={() => {}}>Mất kết nối</ErrorState>
        <Skeleton />
        <StatCard label="Số lượng" value={12} />
        <TextField label="Tên" hint="Tên đầy đủ" />
        <Timeline label="Lịch sử" items={[{ id: "1", time: "2026-01-02T03:00:00Z", title: "Tạo" }]} />
        <DataTable caption="Ds" rows={[{ id: "1", n: "A" }]} rowKey={row => row.id} columns={[{ key: "n", header: "Tên", sortValue: row => row.n }]} />
      </div>,
    );
    expect(await violations(container)).toEqual([]);
  });
});
