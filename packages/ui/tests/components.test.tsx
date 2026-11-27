// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConfirmDialog, DataTable, EmptyState, ErrorState, Skeleton, Tabs, TextField, ToastProvider, useToast } from "../src";

describe("Tabs", () => {
  it("moves with arrow keys, Home and End", async () => {
    const onChange = vi.fn();
    render(<Tabs label="Hồ sơ" value="a" onChange={onChange} items={[{ id: "a", label: "A" }, { id: "b", label: "B" }, { id: "c", label: "C" }]} />);
    const first = screen.getByRole("tab", { name: "A" });
    first.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenLastCalledWith("b");
    await userEvent.keyboard("{End}");
    expect(onChange).toHaveBeenLastCalledWith("c");
    expect(first.getAttribute("tabindex")).toBe("0");
  });
});

describe("DataTable", () => {
  const rows = [{ id: "1", name: "Bình" }, { id: "2", name: "An" }];
  it("sorts by a sortable column and sets aria-sort", async () => {
    render(<DataTable caption="Ds" rows={rows} rowKey={row => row.id} columns={[{ key: "name", header: "Tên", sortValue: row => row.name }]} />);
    await userEvent.click(screen.getByRole("button", { name: "Tên" }));
    const cells = screen.getAllByRole("cell").map(cell => cell.textContent);
    expect(cells).toEqual(["An", "Bình"]);
    expect(screen.getByRole("columnheader").getAttribute("aria-sort")).toBe("ascending");
  });
  it("shows the empty text", () => {
    render(<DataTable caption="Ds" rows={[]} rowKey={() => "x"} columns={[{ key: "n", header: "N" }]} empty="Trống" />);
    expect(screen.getByText("Trống")).toBeTruthy();
  });
});

describe("TextField", () => {
  it("ties the error to the control", () => {
    render(<TextField label="Lý do" error="Bắt buộc" />);
    const input = screen.getByLabelText("Lý do");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(screen.getByRole("alert").id);
  });
});

describe("ConfirmDialog", () => {
  it("opens, and cancel is available", async () => {
    const onCancel = vi.fn();
    render(<ConfirmDialog open title="Xoá?" description="Không hoàn tác" confirmLabel="Xoá" danger onConfirm={() => {}} onCancel={onCancel} />);
    await userEvent.click(screen.getByRole("button", { name: "Huỷ", hidden: true }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("States", () => {
  it("empty state offers the next action", async () => {
    const onAction = vi.fn();
    render(<EmptyState title="Chưa có gì" action={<button type="button" onClick={onAction}>Bắt đầu</button>} />);
    await userEvent.click(screen.getByRole("button", { name: "Bắt đầu" }));
    expect(onAction).toHaveBeenCalled();
  });
  it("error state is announced and can retry", async () => {
    const onRetry = vi.fn();
    render(<ErrorState onRetry={onRetry}>Mất kết nối</ErrorState>);
    expect(screen.getByRole("alert")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Thử lại" }));
    expect(onRetry).toHaveBeenCalled();
  });
  it("skeleton announces loading once", () => {
    render(<Skeleton lines={2} />);
    expect(screen.getByRole("status").textContent).toContain("Đang tải");
  });
});

function ToastProbe({ onReady }: { onReady: (api: { notify: (message: string) => void }) => void }) {
  const api = useToast();
  onReady(api);
  return null;
}

describe("ToastProvider", () => {
  it("shows a message in a polite live region and can dismiss it", async () => {
    let notify: ((message: string) => void) | undefined;
    render(<ToastProvider><ToastProbe onReady={api => { notify = api.notify; }} /></ToastProvider>);
    notify!("Đã lưu");
    expect(await screen.findByText("Đã lưu")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Đóng thông báo" }));
    expect(screen.queryByText("Đã lưu")).toBeNull();
  });
});
