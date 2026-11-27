<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Kế hoạch triển khai Tầng 2 Junctura Workspace

Workspace là không gian làm việc chung cho các tổ chức nhiều đơn vị. Biểu mẫu, vai trò, danh xưng và quy trình nghiệp vụ đến từ gói ngành. DX-OS giữ bản ghi, tệp, quy trình, định danh và audit. Workspace gọi DX-OS qua `@junctura/server-client` bằng định danh app hoặc thay mặt người dùng. Các app Tầng 3 dùng API Workspace để xử lý hồ sơ và công việc liên đơn vị. [Junctura DX-OS](https://github.com/vku2-open-source-2026/junctura-dxos) · [Junctura Health](https://github.com/vku2-open-source-2026/junctura-health)

## Điểm bắt đầu

- Repo Workspace đã public, dùng Apache-2.0, có Issues và bảo vệ `main`.
- Nhánh [`import/health-portal`](https://github.com/vku2-open-source-2026/junctura-workspace/tree/import/health-portal) giữ lịch sử `junctura-health/portal` tách bằng `git subtree split`. Việc đầu tiên là đưa cổng vào cấu trúc Workspace và kiểm lại các luồng hiện có.
- Có thể đặc tả định dạng gói và viết test hợp đồng trước. Dùng bộ giả `createMemoryCore()` của SDK khi có. Nghiệm thu luồng tích hợp trên DX-OS `v0.3.0` đã cập nhật deploy. [Điều kiện phát hành Tầng 1](https://github.com/vku2-open-source-2026/junctura-dxos/issues/50)

## Nền tảng Workspace

| Việc | Tệp chính | Xong khi |
| --- | --- | --- |
| Chuyển cổng từ Junctura Health và giữ lịch sử | `app/`, `server/`, Compose, Dockerfile và CI | Các luồng hiện có của cổng chạy được và CI, REUSE xanh |
| Đặc tả định dạng gói | `docs/PACK_FORMAT.md`, `schemas/pack.schema.json` | Gói Y tế và Giáo dục bản nháp đều qua schema |
| Tách giao diện dùng chung | `packages/ui/` | `@junctura/ui@0.1.0-rc` có 21 thành phần, token, font và style. `@junctura/health-ui` build được với gói này |
| Trung lập hóa nội dung, phiên và dữ liệu | `app/src/`, cấu hình Vite | Nhãn ngành, danh sách app, hợp đồng và quy trình lấy từ gói đã cài. `check:neutral` xanh |
| Thêm bộ đọc gói và lệnh `pack:install` | `server/packs.mjs`, `scripts/pack-install.mjs` | Sau khi định dạng gói và API danh bạ, workflow sẵn sàng, cài được gói Giáo dục nháp trên stack trống |
| Thêm kiểm tra trung lập và lưu trữ | `scripts/`, CI | `check:neutral` và `check:storage` chạy trong CI |
| Đọc nhân sự qua danh bạ DX-OS | `server/staff.mjs` | Danh sách nhân sự lấy từ directory sau khi API sẵn sàng. `check:storage` xanh |

Các tệp cần rà khi trung lập hóa gồm `strings.ts`, `desk/strings.ts`, `desk/d/strings.ts`, `space/strings.ts`, `FACILITY_BY_ROLE` trong `session.ts`, `catalog.ts`, `space/data.ts`, `desk/data.ts`, `health-demo-plan.d.ts` và `vite.config.ts`.

Các thành phần chuyển sang `@junctura/ui` gồm `AppShell`, `Layout`, `Button`, `Card`, `DataTable`, `Dialog`, `Fields`, `Tabs`, `Timeline`, `Toast`, `States`, `StatCard`, `Badge`, `Popover`, `CommandSearch`, `DisplayPrefs`, `IdChip`, `PreviewFrame`, `SignInPage`, `LandingPage` và `JuncturaMark`.

```text
junctura-workspace/
  app/                         Giao diện
  server/                      Backend, API Workspace và bộ đọc gói
  packages/ui/                 @junctura/ui
  examples/packs/education/    Gói Giáo dục mẫu
  schemas/pack.schema.json
  scripts/                    Kiểm tra và cài gói
  docs/                       Định dạng gói, API và kiến trúc
```

Khung repo gồm Compose, Dockerfile, LICENSE, LICENSES, NOTICE, REUSE, README, CHANGELOG, CONTRIBUTING, SECURITY và mẫu issue.

## Gói ngành và dữ liệu

Gói gồm `pack.json`, BPMN và `units.json`. Manifest mô tả nhãn, loại đơn vị, loại hồ sơ, nhóm gửi và nhận, hạn xử lý, biểu mẫu và lựa chọn quyết định của từng bước. `pack:install` tạo loại đơn vị, nhóm và đơn vị mẫu qua API DX-OS, nạp BPMN và ghi `ws_packs`.

- Gói Giáo dục ở `examples/packs/education/` có hai trường, một phòng giáo dục và hai loại hồ sơ **chuyển trường** và **cấp bản sao học bạ**. Luồng chạy với DX-OS và Workspace.
- Gói Y tế ở `junctura-health/pack/` có quy trình **chuyển tuyến** và **thanh toán**. Dùng cả hai gói để kiểm chứng cài, nâng phiên bản, gỡ và đổi gói bằng cấu hình. Workspace ghim bản Health mang gói trong `.junctura-health-version` (bản ghim hiện hành: Health PR #47, `53b0a404…`) và CI kiểm gói thật bằng `readPack` qua `scripts/check-health-pack.mjs`.

| Dữ liệu Workspace | Lưu ở DX-OS |
| --- | --- |
| Đơn vị, loại đơn vị, thành viên, nhóm | Directory và Keycloak groups |
| Gói đã cài | `ws_packs` và workflow definitions |
| Hồ sơ | Workflow execution và `ws_cases` |
| Bước xử lý, quyết định, lý do | Lịch sử workflow |
| Ghi chú và tệp | `ws_case_notes`, `/v2/objects` gắn `recordRef` |
| Bảng tin và tùy chọn người dùng | `ws_notices`, `ws_user_prefs` |

`ws_cases` chứa mã hồ sơ, loại, đơn vị gửi và nhận, đối tượng, mức khẩn, trạng thái và hạn xử lý. Kiểm tra lưu trữ bao phủ SQLite, ghi tệp ngoài thư mục tạm, đọc `seed/` lúc chạy và đọc `.env` của repo khác. Nạp dữ liệu demo qua API.

## Module và tiêu chí nghiệm thu

| Module | Xong khi | Phụ thuộc |
| --- | --- | --- |
| Việc hôm nay | Việc mới xuất hiện trong 2 giây mà không cần tải lại. Việc quá hạn có cờ | Hộp việc theo nhóm, hạn xử lý và SSE |
| Bảng tin | Đăng, ghim và lọc người nhận qua `ws_notices` | Lọc bản ghi theo trường chỉ mục |
| Danh bạ | Tìm đơn vị và người theo tên từ danh bạ DX-OS | Directory |
| Tài liệu đơn vị | Tải lên, quét mã độc và liệt kê theo nhãn | Object storage, nhãn và liên kết bản ghi |
| Hồ sơ liên đơn vị | Mở theo biểu mẫu gói, quyết định kèm lý do, tệp, ghi chú và dòng thời gian. Chạy được luồng chuyển tuyến trong Workspace | Hoàn tất bước, quyền nhóm, lịch sử workflow và tệp |
| Thư viện loại hồ sơ | Xem sơ đồ, biểu mẫu, nhóm và hạn của cả hai gói | Bộ đọc gói |
| Quản lý gói | Cài, nâng phiên bản, gỡ. Đổi Giáo dục ↔ Y tế bằng cấu hình | Lệnh cài gói và hai gói mẫu |
| Điều hành và CSV | Số theo trạng thái, loại, đơn vị và ngày khớp dữ liệu. CSV mở được bằng bảng tính | API tổng hợp, hộp việc và hạn xử lý |
| Đối soát audit | Tìm được lượt mở hồ sơ theo đơn vị, hành động và đối tượng. Xem kết quả xác minh và tải NDJSON kèm đầu chuỗi băm | Quyền đọc, xác minh và xuất audit |
| API cho Tầng 3 | Test hợp đồng và tài liệu `docs/API.md` xanh | Hồ sơ liên đơn vị và hoàn tất bước kèm ghi bản ghi |
| Tìm kiếm toàn văn | Tìm hồ sơ, bảng tin và tài liệu trong phạm vi quyền đọc | API tìm kiếm DX-OS |
| Cổng cá nhân chủ dữ liệu | Quản lý đồng thuận, xem ai đã xem, phản hồi truy cập khẩn cấp và đánh dấu lượt lạ | API `/v1/me/*` |
| Hậu kiểm truy cập khẩn cấp | Đơn vị quản lý xem và kết luận từng lần | API truy cập khẩn cấp và phản hồi |
| Trợ lý hỏi đáp trên bảng tin và tài liệu | Tắt mặc định. Khi bật, câu trả lời luôn dẫn nguồn | Tìm kiếm theo quyền và endpoint mô hình cấu hình được |

Các nhóm module H/P/D/I dùng để tổ chức công việc. Giao diện dùng tên tính năng dành cho người dùng.

## API cho Tầng 3

| Thao tác | API dự kiến |
| --- | --- |
| Tạo, liệt kê và xem hồ sơ | `POST /api/cases`, `GET /api/cases`, `GET /api/cases/{id}` |
| Liệt kê và hoàn tất việc | `GET /api/tasks`, `POST /api/tasks/{id}/complete` |
| Đính kèm tệp | `POST /api/cases/{id}/files` |
| Đọc bảng tin và danh bạ | `GET /api/notices`, `GET /api/directory` |

Xác thực bằng token người dùng rồi gọi DX-OS thay mặt người đó để quyền nhóm và đơn vị tiếp tục được kiểm ở lõi. API hoàn tất việc chuyển tiếp `records` cho DX-OS xử lý cùng bước workflow qua outbox.

## Phát hành và demo

- Chạy CI với kiểm tra trung lập, lưu trữ, REUSE và hợp đồng API. Kiểm thử tích hợp trên stack thật, gồm đổi gói và tạo lại container để đối chiếu dữ liệu vẫn ở DX-OS.
- Kiểm thử ba mức gồm DX-OS, DX-OS với Workspace và hai gói lần lượt, rồi toàn bộ bộ Y tế với registry và các app. Kiểm tra quy trình chuyển tuyến chạy trong Workspace khi tắt Clinic và Hospital.
- Kiểm tra cài trên máy sạch theo README. Mục tiêu là người mới cài được mỗi mức demo trong ba lệnh và dưới 15 phút. Quét bảo mật trước triển khai và xử lý lỗi mức cao. Hoàn thiện README, CONTRIBUTING, SECURITY và mẫu issue. Môi trường demo Workspace với gói Y tế dùng `health.junctura.studio`, dữ liệu mẫu chuẩn hóa và tài khoản demo chỉ xem.
- Mục tiêu phát hành là Workspace `0.1.0` và `@junctura/ui` `0.1.0`. Gói nguồn, SHA-256, SBOM và release notes đi qua workflow phát hành dùng chung của DX-OS. Cập nhật phiên bản đã kiểm chung trong `junctura-health/suite.json` cho Junctura Suite 2026.12.

Diễn tập cả ba mức demo, chuẩn bị video dự phòng và chạy kiểm thử tích hợp của Junctura Health với đúng các phiên bản ghi trong `suite.json`.

Mỗi việc có issue mô tả phạm vi, phụ thuộc và điều kiện hoàn thành. Push lên nhánh riêng, mở PR vào `main`, cập nhật CHANGELOG `Unreleased` và thêm SPDX cho tệp mới.
