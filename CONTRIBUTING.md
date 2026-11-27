<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Đóng góp vào Junctura Workspace

Cảm ơn bạn quan tâm đến Junctura Workspace. Tài liệu này mô tả cách mở issue, mở pull request (PR), chạy các kiểm tra và giữ đúng quy ước REUSE/SPDX, CHANGELOG của repo.

## Chuẩn bị môi trường

- Node 24, đúng phiên bản đã ghim trong `.node-version`.
- Docker với Compose, dùng để kiểm tra `compose.yaml`.
- Python có sẵn `pip` để cài công cụ `reuse` (xem `requirements-reuse.txt`).
- Cổng build và chạy được chỉ từ kho này (gói ngành đến từ `GET /api/pack` của backend); xem [docs/PORTAL.md](docs/PORTAL.md). Checkout Junctura Health ở `.junctura-health/` (phiên bản ghi trong `.junctura-health-version`) chỉ cần cho kiểm tra gói Y tế ghim của CI, không cần để build hay chạy cổng.

## Chạy các kiểm tra

Các lệnh dưới đây khớp với workflow `Checks` trong `.github/workflows/ci.yml` và hướng dẫn chạy trong [docs/PORTAL.md](docs/PORTAL.md):

| Lệnh | Mục đích |
| --- | --- |
| `python -m pip install -r requirements-reuse.txt && reuse lint` | Kiểm tra metadata bản quyền REUSE/SPDX |
| `docker compose config --quiet` | Kiểm tra cấu hình Compose |
| `npm run test:guards` | Chạy kiểm thử fixture của các CI guard (Node ghim, không cần cài phụ thuộc) |
| `npm run check:neutral` | CI guard `check:neutral`: mã chạy của cổng không mang từ vựng/dữ liệu/import ngành cứng và không import nguồn Health, demo/seed cũ; ngoại lệ được ghi lý do trong `scripts/sector-neutral-allowlist.json` (mục không còn dùng sẽ bị báo lỗi) |
| `npm run check:storage` | CI guard `check:storage`: mã chạy không lưu dữ liệu nghiệp vụ vào SQLite, không ghi tệp host tuỳ ý, không đọc seed ở production và không đọc `.env` của kho khác; ngoại lệ nằm trong `scripts/storage-allowlist.json` |
| `npm --prefix server ci` | Cài phụ thuộc backend |
| `npm --prefix server test` | Chạy kiểm thử backend |
| `node scripts/check-health-pack.mjs` | Kiểm gói Y tế thật trong checkout Junctura Health ghim (cần `.junctura-health/`) |
| `npm --prefix packages/ui ci` | Cài phụ thuộc giao diện dùng chung của kho |
| `npm --prefix app ci` | Cài phụ thuộc frontend |
| `npm --prefix app run typecheck` | Kiểm tra kiểu frontend |
| `npm --prefix app test` | Chạy kiểm thử frontend |
| `npm --prefix app run build` | Build frontend |

Trên GitHub, CI checkout Junctura Health ở phiên bản ghim trong `.junctura-health-version` (chỉ `pack/`) và kiểm gói Y tế thật bằng lệnh trên; frontend và backend không dùng checkout này. Khi chạy cục bộ, các lệnh frontend chạy được không cần `.junctura-health/`.

Thứ tự của workflow `Checks` là chủ đích và giữ nguyên trên runner sạch: các bước ổn định, không cần cài đặt trước tiên (REUSE, Compose, schema, hợp đồng API và hai CI guard), sau đó cài phụ thuộc backend ghim (`npm --prefix server ci`) — cần cho `scripts/check-health-pack.mjs` vì nó import `server/packs.mjs` (ajv/saxes từ `server/node_modules`) — rồi kiểm gói Y tế ghim, kiểm thử backend, và typecheck, kiểm thử, build frontend nằm cuối; không cài phụ thuộc nào hai lần. Hai guard quét mã chạy trong phạm vi `app/src/`, `packages/ui/src/`, các mô-đun JS/TS của `server/` ở mọi cấp lồng nhau (trừ kiểm thử), `app/index.html`, `app/public/config.example.json` và các điểm vào cấu hình build đã xuất bản (`vite.config.ts`, tsconfig); pack fixture, kiểm thử và công cụ vận hành nằm ngoài phạm vi; khi cần một ngoại lệ thật, thêm mục có lý do vào allowlist thay vì nới lỏng guard (mục `file-write` phải nêu đúng dòng vi phạm).

## Mở issue

Dùng mẫu issue trong `.github/ISSUE_TEMPLATE/`:

- **Việc** — công việc mới, theo cách tổ chức trong [docs/PLAN.md](docs/PLAN.md): mỗi việc có phạm vi, phụ thuộc và điều kiện nghiệm thu.
- **Lỗi** — báo lỗi khi chạy cổng hoặc backend. Không dùng mẫu này để mô tả chi tiết lỗ hổng bảo mật — xem [SECURITY.md](SECURITY.md).

Repo chỉ nhận issue theo hai mẫu trên, trừ một ngoại lệ: issue trống được dành riêng làm dự phòng báo cáo lỗ hổng bảo mật khi không có kênh báo cáo riêng tư — xem [SECURITY.md](SECURITY.md). Nếu chưa rõ thuộc mẫu nào, hãy mở **Việc** và mô tả thêm.

## Mở PR

1. Làm việc trên nhánh riêng, một nhánh cho một issue; push lên fork hoặc nhánh cùng repo.
2. Thông điệp commit ngắn gọn, có tiền tố phạm vi như trong lịch sử hiện có (`docs:`, `fix(portal):`, `ci:`).
3. Mở PR vào `main`, dẫn về issue liên quan. CI chạy workflow `Checks`: `reuse lint`, cấu hình Compose, các CI guard (`check:neutral`, `check:storage`), kiểm gói Y tế ghim, kiểm thử backend, typecheck, kiểm thử và build frontend.
4. PR có thể merge khi CI xanh và đã có lượt duyệt; lịch sử hiện tại merge bằng merge commit.

## Thêm SPDX cho tệp mới

Mọi tệp mới đều cần metadata bản quyền SPDX, trừ `*.json` (đã được ghi trong `REUSE.toml`).

Với tệp hỗ trợ chú thích HTML (Markdown, XML):

```html
<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->
```

Với tệp dùng `#` làm chú thích (YAML, shell, Dockerfile, Makefile, …):

```yaml
# SPDX-FileCopyrightText: 2026 Junctura Contributors
# SPDX-License-Identifier: Apache-2.0
```

Chạy `reuse lint` trước khi push để xác nhận metadata hợp lệ.

## Cập nhật CHANGELOG

Thêm đầu mục dưới mục `## Unreleased` trong `CHANGELOG.md` cho mỗi thay đổi đáng chú ý của PR (tính năng mới, sửa lỗi, thay đổi cấu hình). Không tự đổi số phiên bản; người phát hành sẽ cập nhật khi release.

## Báo cáo lỗ hổng bảo mật

Không mở issue công khai cho lỗ hổng bảo mật. Xem [SECURITY.md](SECURITY.md) để biết kênh báo cáo.

## Bản quyền các đóng góp

Bằng cách đóng góp, bạn đồng ý cấp nội dung đóng góp theo giấy phép Apache-2.0 của repo (xem `LICENSE` và `NOTICE`).
