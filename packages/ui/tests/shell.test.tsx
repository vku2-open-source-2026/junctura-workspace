// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import { AppShell, CommandSearch, DisplayPrefsProvider, LandingPage, Popover, SegmentedControl, SignInPage } from "../src";

const NAV = [{ label: "Việc", items: [{ id: "today", label: "Hôm nay" }, { id: "queue", label: "Hàng đợi" }] }, { label: "Dữ liệu", items: [{ id: "records", label: "Hồ sơ", count: 3 }] }];
const STATIONS = [{ id: "s1", name: "Trạm Hoà Mỹ" }, { id: "s2", name: "Trạm An Hải" }];

function shell(extra: Partial<React.ComponentProps<typeof AppShell>> = {}) {
  return render(
    <DisplayPrefsProvider>
      <AppShell product="Workspace" nav={NAV} current="today" onNavigate={() => {}} user={{ name: "Phạm Thu Hà", role: "Biên tập" }} onSignOut={() => {}} {...extra}><p>Nội dung</p></AppShell>
    </DisplayPrefsProvider>,
  );
}

describe("AppShell", () => {
  it("renders navigation groups with headings and marks the current page", () => {
    shell();
    expect(screen.getAllByText("Dữ liệu").length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /Hôm nay/ }).some(button => button.getAttribute("aria-current") === "page")).toBe(true);
  });
  it("still accepts the flat navigation list of 0.1", () => {
    shell({ nav: [{ id: "a", label: "Một" }, { id: "b", label: "Hai" }] });
    expect(screen.getAllByRole("button", { name: "Một" }).length).toBeGreaterThan(0);
  });
  it("switches station and reports it", async () => {
    const onStationChange = vi.fn();
    shell({ unit: { name: "Đơn vị", stations: STATIONS, currentStationId: "s1", onStationChange } });
    await userEvent.click(screen.getByRole("button", { name: /Trạm đang làm việc: Trạm Hoà Mỹ/ }));
    await userEvent.click(screen.getByRole("button", { name: /Trạm An Hải/ }));
    expect(onStationChange).toHaveBeenCalledWith("s2");
  });
  it("opens quick find with the slash key, not while typing", async () => {
    const onSearch = vi.fn(() => []);
    shell({ search: { onSearch, onSelect: () => {}, placeholder: "Tìm hồ sơ" } });
    await userEvent.keyboard("/");
    expect(await screen.findByRole("combobox", { name: "Từ khoá tìm kiếm" })).toBeTruthy();
    expect(screen.getByRole("combobox").getAttribute("placeholder")).toBe("Tìm hồ sơ");
  });
  it("still accepts the 0.1 search shape without a placeholder and falls back to Tìm kiếm", async () => {
    shell({ search: { onSearch: () => [], onSelect: () => {} } });
    expect(screen.getByText("Tìm kiếm")).toBeTruthy();
    await userEvent.keyboard("/");
    expect((await screen.findByRole("combobox", { name: "Từ khoá tìm kiếm" })).getAttribute("placeholder")).toBe("Tìm kiếm");
  });
  it("shows the notification count in the button name", () => {
    shell({ notifications: [{ id: "1", title: "A" }, { id: "2", title: "B" }] });
    expect(screen.getByRole("button", { name: "Thông báo, 2 mục" })).toBeTruthy();
  });
  it("has no axe violations", async () => {
    const { container } = shell({ unit: { name: "Đơn vị", stations: STATIONS, currentStationId: "s1" }, search: { onSearch: () => [], onSelect: () => {}, placeholder: "Tìm hồ sơ" }, notifications: [{ id: "1", title: "A" }] });
    const result = await axe.run(container, { rules: { "color-contrast": { enabled: false }, region: { enabled: false } } });
    expect(result.violations.map(violation => violation.id + ": " + violation.nodes.map(node => node.html).join(" | "))).toEqual([]);
  });
});

describe("CommandSearch", () => {
  it("searches, moves with arrows and selects with Enter", async () => {
    const onSelect = vi.fn();
    const onSearch = vi.fn((query: string) => [{ id: "1", title: `An ${query}` }, { id: "2", title: "Bình" }]);
    render(<CommandSearch open onClose={() => {}} onSearch={onSearch} onSelect={onSelect} placeholder="Tìm hồ sơ" />);
    await userEvent.type(screen.getByRole("combobox"), "ng");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    await userEvent.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith({ id: "2", title: "Bình" });
  });
  it("ignores a slow earlier response", async () => {
    let release: (value: { id: string; title: string }[]) => void = () => {};
    const slow = new Promise<{ id: string; title: string }[]>(resolve => { release = resolve; });
    const onSearch = vi.fn((query: string) => (query === "ab" ? slow : [{ id: "n", title: "Mới" }]));
    render(<CommandSearch open onClose={() => {}} onSearch={onSearch} onSelect={() => {}} placeholder="Tìm hồ sơ" />);
    await userEvent.type(screen.getByRole("combobox"), "ab");
    await userEvent.type(screen.getByRole("combobox"), "c");
    await waitFor(() => expect(screen.getByText("Mới")).toBeTruthy());
    release([{ id: "o", title: "Cũ" }]);
    await Promise.resolve();
    expect(screen.queryByText("Cũ")).toBeNull();
  });
  it("says so when nothing is found", async () => {
    render(<CommandSearch open onClose={() => {}} onSearch={() => []} onSelect={() => {}} placeholder="Tìm hồ sơ" />);
    await userEvent.type(screen.getByRole("combobox"), "zz");
    expect(await screen.findByText("Không tìm thấy kết quả")).toBeTruthy();
  });
});

describe("Popover", () => {
  it("closes on Escape and returns focus to the button", async () => {
    render(<Popover label="Menu" trigger="Mở">{() => <button type="button">Mục</button>}</Popover>);
    const trigger = screen.getByRole("button", { name: "Mở" });
    await userEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await userEvent.keyboard("{Escape}");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });
});

describe("SegmentedControl", () => {
  it("selects exactly one option", async () => {
    const onChange = vi.fn();
    render(<SegmentedControl label="Lọc" value="a" onChange={onChange} options={[{ value: "a", label: "Tất cả" }, { value: "b", label: "Đã gửi" }]} />);
    expect(screen.getByRole("radio", { name: "Tất cả" }).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("radio", { name: "Đã gửi" }));
    expect(onChange).toHaveBeenCalledWith("b");
  });
});

describe("breadcrumbs and sign-in", () => {
  it("shows group, section and the open record once each", () => {
    render(
      <DisplayPrefsProvider>
        <AppShell product="Workspace" nav={[{ label: "Việc", items: [{ id: "today", label: "Hôm nay" }] }, { label: "Dữ liệu", items: [{ id: "records", label: "Hồ sơ" }] }]} current="records" onNavigate={() => {}} breadcrumbs={["Hồ sơ 0001"]}>x</AppShell>
      </DisplayPrefsProvider>,
    );
    const trail = screen.getByRole("navigation", { name: "Vị trí hiện tại" });
    expect(trail.textContent).toBe("WorkspaceDữ liệuHồ sơHồ sơ 0001");
    expect(trail.querySelector("[aria-current=page]")?.textContent).toBe("Hồ sơ 0001");
  });
  it("does not repeat a section named like its group", () => {
    render(
      <DisplayPrefsProvider>
        <AppShell product="Workspace" nav={[{ label: "Hôm nay", items: [{ id: "today", label: "Hôm nay" }] }]} current="today" onNavigate={() => {}}>x</AppShell>
      </DisplayPrefsProvider>,
    );
    expect(screen.getByRole("navigation", { name: "Vị trí hiện tại" }).textContent).toBe("WorkspaceHôm nay");
  });
  it("sign-in page calls back and shows the message", async () => {
    const onSignIn = vi.fn(); const onBack = vi.fn();
    render(<SignInPage product="Workspace" onSignIn={onSignIn} onBack={onBack} message="Phiên đã hết hạn" />, { wrapper: DisplayPrefsProvider });
    expect(screen.getByText("Phiên đã hết hạn")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /Đăng nhập với Junctura/ }));
    await userEvent.click(screen.getByRole("button", { name: /Về trang giới thiệu/ }));
    expect(onSignIn).toHaveBeenCalledOnce(); expect(onBack).toHaveBeenCalledOnce();
  });
  it("landing page shows only the sections it is given", () => {
    render(<LandingPage product="Workspace" headline="H" lead="L" onSignIn={() => {}} faq={{ title: "Hỏi đáp", items: [{ q: "Q?", a: "A." }] }} />, { wrapper: DisplayPrefsProvider });
    expect(screen.getByRole("button", { name: "Hỏi đáp" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Lợi ích" })).toBeNull();
  });
});
