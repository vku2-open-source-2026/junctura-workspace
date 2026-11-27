<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# API Workspace cho ứng dụng Tầng 3 (bản dự thảo)

Tài liệu này chốt hợp đồng API Workspace mà các ứng dụng **Tầng 3** gọi để xử lý hồ sơ và công việc liên đơn vị: hồ sơ (cases), việc (tasks), tệp (files), bảng tin (notices) và danh bạ (directory). Hợp đồng máy đọc nằm ở [`docs/contracts/workspace-api.openapi.json`](contracts/workspace-api.openapi.json) (OpenAPI 3.1.1, tám thao tác, chưa có lệnh chạy đi kèm — runtime được theo dõi ở các issue tính năng theo [PLAN.md](PLAN.md) và [Điều kiện phát hành Tầng 1](https://github.com/vku2-open-source-2026/junctura-dxos/issues/50)).

Mọi lời gọi DX-OS nêu trong tài liệu được đối chiếu với bản chép pinned của Junctura DX-OS tại `.junctura/dxos-reference/` — **commit `3e0ce519530057f47112f1a6b4f544202deb8bd9`**, tệp `docs/contracts/foundation-api.openapi.json` và SDK `@junctura/server-client` `0.3.0-rc.1` (`sdk/node/`). Mỗi thao tác của Workspace ghi rõ các lời gọi thượng nguồn trong trường `x-workspace-upstream` của hợp đồng.

## Cổng hiện có và API Tầng 3

Repo đang có hai lớp API `/api` cần phân biệt:

**Lớp 1 — route cổng hiện có** (backend nhập từ Junctura Health, xem [PORTAL.md](PORTAL.md)): phục vụ giao diện Cổng, tên tài nguyên tiếng Việt, định danh lấy từ danh tính đã xác minh của người gọi qua DX-OS (`GET /v1/identity` bằng bearer người dùng, trong `server/staff.mjs`). Đây là nội dung demo của Cổng, không phải hợp đồng cho app ngoài:

| Route cổng hiện có | Ý nghĩa |
| --- | --- |
| `GET /api/pack` | **Công khai, chỉ đọc**: phép chiếu trắng danh sách của gói đã cài (nhãn, loại hồ sơ, nhóm, loại đơn vị, biểu mẫu, hạn, sơ đồ nút–cạnh). Xem ranh giới công khai/không công khai trong [PORTAL.md](PORTAL.md). |
| `GET /api/me` | Danh tính đã xác minh của người gọi (DX-OS `GET /v1/identity` bằng bearer người dùng; đơn vị là tư cách thành viên đã xác minh, kèm nhóm đã xác minh và quyền đăng bảng tin) |
| `GET`/`POST` `/api/bang-tin` | Bảng tin phối hợp; đăng chỉ với tư cách thành viên `so-y-te` kèm nhóm đã xác minh `/so-y-te/ban-tin` |
| `GET`/`POST` `/api/ho-so/{executionId}/ghi-chu` | Ghi chú trên hồ sơ |
| `GET`/`POST` `/api/ho-so/{executionId}/tep` | Tệp đính kèm trên hồ sơ |
| `GET /api/tep/{fileId}` | Tải tệp đính kèm |

**Lớp 2 — API Tầng 3 dự thảo** (tài liệu này): tên tài nguyên tiếng Anh ổn định, định danh người dùng thật và quyền chuyển tiếp qua DX-OS, hợp đồng có kiểm tra tự động. App Tầng 3 chỉ gọi lớp 2; lớp 1 không là một phần của cam kết này và sẽ được gỡ bỏ dần khi các module tương ứng chạy trên API mới.

## Định danh và chuyển tiếp quyền

Mọi thao tác đều mang **token người dùng** (`Authorization: Bearer`, token truy cập của Junctura). Backend Workspace làm đúng ba bước rồi không bao giờ tự quyết quyền:

1. **Xác minh token người dùng**: RS256 qua JWKS, kiểm `iss`/`exp`/`azp` như backend hiện có. Giá trị `azp` hợp lệ cho Tầng 3 **không tái dùng** giá trị hiện tại của Cổng (`health-portal-web`): chỉ danh mục cho phép khi onboarding quyết định các client browser/app đủ điều kiện gọi API Workspace.
2. **Đổi token lấy bearer ủy quyền**: `POST /v1/token-exchange` (`exchangeUserToken`) với app identity (client credentials trong bộ nối của `@junctura/server-client`), nhận bearer delegated có `expires_in` từ 1–60 giây, chỉ dùng trong một lượt gọi và không bao giờ lưu hay ghi log.
3. **Gọi DX-OS thay mặt người dùng** bằng bearer trên. Lõi DX-OS kiểm tenant, đơn vị và nhóm ứng viên của người dùng cho từng lời gọi — quyền nhóm và đơn vị tiếp tục được kiểm ở lõi.

Nguyên tắc sao chép từ hợp đồng DX-OS: "Tenant/app IDs in caller headers or JSON never supply authority" — mã tenant/app trong header hay thân yêu cầu không bao giờ tạo quyền. App identity chỉ dùng để bootstrap kết nối và để sở hữu các bản ghi `ws_*`; nó không bao giờ xuất hiện trong yêu cầu của app Tầng 3.

## Nguồn dữ liệu và thứ tự ưu tiên

Workspace là tầng ứng dụng: nó không có kho riêng ngoài DX-OS. Trọng số của từng nguồn được chốt như sau:

| Dữ liệu | Nguồn chuẩn (ưu tiên khi lệch nhau) | Nguồn bổ trợ |
| --- | --- | --- |
| Trạng thái hồ sơ | Execution workflow (`GET /v1/workflows/executions/{executionId}`) | Bản chiếu `ws_cases` chỉ để liệt kê; lệch thì execution thắng và Workspace cập nhật lại bản chiếu |
| Danh sách hồ sơ | Bản chiếu `ws_cases` (`GET /v2/data/ws_cases`, lọc `where` theo trường chỉ mục) | DX-OS không có lệnh liệt kê execution (xem [Khoảng trống DX-OS](#khoảng-trống-dx-os)) |
| Hạn xử lý | `dueAt` do Workspace ghi ngay khi mở hồ sơ, `deadlineDays` × 24 giờ theo [PACK_FORMAT.md](PACK_FORMAT.md) | `dueAt` của execution là nguồn chuẩn khi có |
| Bước đã hoàn tất, quyết định, lý do | Lịch sử workflow (`GET /v1/workflows/executions/{executionId}/history`) | Dòng thời gian ghép từ lịch sử + tệp + ghi chú |
| Ghi chú, tệp đính kèm | Bản ghi thuộc app Workspace: `ws_case_notes`, `ws_case_files` | Byte tệp ở `/v2/objects` gắn `recordRef`; tên gốc chỉ nằm trong bản ghi metadata |
| Bảng tin | `ws_notices` | Lọc người nhận qua trường chỉ mục của schema bộ sưu tập |
| Danh bạ | Directory DX-OS (`/v1/directory/*`, đòi quyền quản trị danh bạ — xem [Khoảng trống DX-OS](#khoảng-trống-dx-os)) | Không đệm ở Workspace quá một trang |

Các bộ sưu tập `ws_cases`, `ws_case_notes`, `ws_case_files`, `ws_notices` là bản ghi thuộc app Workspace; DX-OS cách ly theo đơn vị đã xác minh và chỉ trả về những gì người dùng (qua token ủy quyền) được đọc. `records` trong hoàn tất việc cũng chỉ nhận các bộ sưu tập `ws_*` này — danh mục này được chốt thành enum trong schema hợp đồng; runtime phải kiểm phạm vi của người gọi cho từng bộ sưu tập theo đơn vị/hồ sơ và không nhận các trường định danh do caller tự cung (người ghi, thời điểm… luôn lấy từ token đã xác minh), còn khối `records` hợp lệ vẫn được chuyển tiếp nguyên khối cho DX-OS.

Về hạn xử lý theo bước: `taskDueAt` trong hợp đồng pinned của DX-OS là **thời điểm tuyệt đối**, áp lại cho từng lần kích hoạt của bước; nó không thiết lập hạn **tương đối theo từng kích hoạt** (ví dụ `deadlineDays` của gói đếm từ khi mở hồ sơ) nếu chưa có ánh xạ runtime đã kiểm. Do đó hợp đồng này chỉ cam kết `dueAt` do Workspace ghi ngay khi mở hồ sơ; hạn riêng theo từng lần kích hoạt bước chưa nằm trong cam kết.

## Phân trang

Mọi danh sách trả về `{ items, nextCursor }`:

- `limit` từ 1–100, mặc định 50 (của việc: vẫn 1–100, mặc định 50).
- `cursor` là chuỗi mờ dài tối đa 1024 lấy từ `nextCursor` của trang trước; dùng lại nó với **cùng bộ lọc** — đổi bộ lọc kèm cursor cũ là lỗi 400.
- `nextCursor: null` là trang cuối.
- Bộ lọc của danh sách chỉ thu hẹp tập đã được phép đọc; không có bộ lọc nào mở rộng quyền (ngữ nghĩa của `GET /v1/workflows/tasks` và `GET /v2/data/{collection}`).

## Lỗi

Mọi lỗi đều là JSON `{ "error": "<code>", "requestId": "<uuid>?" }`, không bao giờ HTML:

| HTTP | `error` | Khi nào |
| --- | --- | --- |
| 400 | `invalid_input` | Sai cú pháp, thiếu trường, giá trị ngoài miền, `cursor` hỏng hoặc dùng lệch bộ lọc |
| 401 | `unauthorized` | Thiếu, sai hoặc hết hạn token người dùng |
| 403 | `forbidden` | Người dùng không thuộc đơn vị/nhóm được phép; mã từ chối của lõi (`task_group_required`, …) được giữ nguyên khi qua thẳng từ DX-OS |
| 403 | `task_group_required` | Người hoàn tất không thuộc nhóm ứng viên nào của bước |
| 404 | `not_found` | Không tồn tại hoặc bị ẩn khỏi người dùng |
| 409 | `task_claimed` | Bước đang bị người khác giữ claim; kèm `claimedBy`, `claimedUntil` |
| 409 | `task_already_completed` | Bước đã hoàn tất với một lần gửi khác |
| 413 | `too_large` | Tệp vượt 5 MiB |
| 415 | `unsupported_type` | Loại nội dung không được nhận |
| 422 | `idempotency_key_reused` | `Idempotency-Key` còn hạn đã bị gán cho yêu cầu khác |
| 422 | `malware_detected` | Tệp không qua quét mã độc; không bao giờ được công bố |
| 503 | `junctura_unavailable` | DX-OS không trả lời được hoặc hết giờ; với lệnh ghi, kết quả có thể **không xác định** khi lõi đã nhận lệnh trước khi mất kết nối — xem ngay dưới bảng |

Mã `task_*` và ngữ nghĩa 403 của lõi đi thẳng từ DX-OS; Workspace không dịch lại thành mã riêng để app Tầng 3 xử lý nhất quán. Mã từ chối truy cập ứng dụng của lõi (`not_assigned_to_app`, `unit_mismatch`, …) luôn lộ ra ngoài dưới dạng `forbidden` kèm `requestId` để tra audit.

Về 503: mọi thao tác phụ thuộc lệnh gọi DX-OS — kể cả liệt kê (`GET /api/cases`, `GET /api/tasks`, `GET /api/notices`, `GET /api/directory`), xem hồ sơ và đính kèm tệp — đều dùng chung phản hồi 503 `junctura_unavailable`. Khẳng định "chưa ghi gì" là sai khi lõi có thể đã nhận một lệnh ghi trước khi hết giờ: kết quả lúc đó là **không xác định**. App Tầng 3 gửi lại **đúng key `Idempotency-Key` và đúng thân yêu cầu**: nếu lệnh gốc đã thực hiện xong, lời gửi lại nhận lại kết quả đầu tiên nhờ ngữ nghĩa idempotency; nếu chưa, lệnh gốc được thực hiện một lần. Không có tình huống nào Workspace tự kết luận kết quả của lõi.

## Idempotency

Mọi `POST` đều nhận `Idempotency-Key` (UUID chữ thường); với `POST /api/cases` và `POST /api/tasks/{taskId}/complete` là bắt buộc, với `POST /api/cases/{caseId}/files` là tùy chọn:

- **Gửi lại đúng**: cùng key, cùng thân yêu cầu — trả lại đúng phản hồi đầu tiên trong cửa sổ phát lại, kể cả khi bước đã hoàn tất từ lần đầu. Không nhân đôi hồ sơ, không hoàn tất bước hai lần, không tạo bản ghi thứ hai.
- **Gửi lại lệch**: cùng key nhưng khác thân yêu cầu — `422 idempotency_key_reused`; dữ liệu cũ giữ nguyên.
- Ngữ nghĩa bắt nguồn từ DX-OS: start workflow phát lại 201 với key gốc; hoàn tất việc phát lại kết quả đầu tiên với key gốc trong thân lệnh. Workspace giữ nguyên hành vi này và truyền key qua từng lời gọi thượng nguồn.

## `records` và hoàn tất bước qua outbox

`POST /api/tasks/{taskId}/complete` là lệnh duy nhất ghi dữ liệu nghiệp vụ cùng lúc với chuyển bước:

```json
{
  "decision": "tiep-nhan",
  "reason": "Không cần khi outcome là approve",
  "form": { "ma-chuyen-tuyen": "CT-2026-0001" },
  "records": [
    { "collection": "ws_case_notes", "data": { "caseId": "9f1d2c3a-…", "text": "Đã tiếp nhận bệnh nhân" } }
  ]
}
```

- `decision` là một `steps[].decisions[].id` của bước trong gói ngành; khi quyết định đặt `requiresReason: true` thì `reason` bắt buộc — luật này thuộc gói nên được Workspace kiểm lúc chạy theo gói đã cài, không ghi cứng trong schema.
- `form` là giá trị của `steps[].form` của bước.
- `records` là 1–10 mục `{ collection, data }` — tạo bản ghi mới thuộc app Workspace, với `collection` chỉ nhận các bộ sưu tập Workspace đã kể trên (schema chốt thành enum). Runtime kiểm phạm vi của người gọi cho từng bộ sưu tập theo đơn vị/hồ sơ và từ chối các trường định danh do caller tự cung. Workspace chuyển tiếp nguyên khối này cho `POST /v1/workflows/executions/{executionId}/complete`; DX-OS kiểm tra, cam kết cùng bước chuyển trong **outbox hoàn tất bền vững** (durable completion outbox) và trả 202 khi bước đang chờ chuyển.
- Khi nhận 202, đọc lại hồ sơ và lịch sử để thấy bước chuyển xong; các bước song song vẫn chờ. Trong lúc một lần hoàn tất đang chờ, việc hủy hồ sơ bị xung đột.

Nhờ `records` đi cùng outbox, ghi chú/kết quả của bước không bao giờ lạc khỏi bước chuyển: hoặc cả hai thành công, hoặc cả hai không xảy ra.

## Tham chiếu thao tác

| Thao tác | Lời gọi DX-OS thượng nguồn (`x-workspace-upstream`) |
| --- | --- |
| `POST /api/cases` — mở hồ sơ | `exchangeUserToken` → `startWorkflowWithDeadlines` (kèm hạn theo gói) → `createVersionedRecord` vào `ws_cases` |
| `GET /api/cases` — liệt kê hồ sơ | `exchangeUserToken` → `listFilteredRecords` trên `ws_cases`, mới nhất trước |
| `GET /api/cases/{caseId}` — xem hồ sơ | `exchangeUserToken` → `getVersionedRecord` trên `ws_cases` → `getWorkflowWithDeadline` (trạng thái chuẩn) |
| `GET /api/tasks` — việc hôm nay | `exchangeUserToken` → `listWorkflowTasks` (lọc `overdue`) → nối `caseId` từ `ws_cases` |
| `POST /api/tasks/{taskId}/complete` — hoàn tất bước | `exchangeUserToken` → `completeWorkflowTask` (quyết định/lý do làm `output`, biểu mẫu làm `variables`, `records` chuyển tiếp, outbox) |
| `POST /api/cases/{caseId}/files` — đính kèm tệp | `exchangeUserToken` → `uploadObjectWithMetadata` trên `/v2/objects` (quét mã độc, `recordRef` trỏ bản ghi hồ sơ) → `createVersionedRecord` vào `ws_case_files` |
| `GET /api/notices` — đọc bảng tin | `exchangeUserToken` → `listFilteredRecords` trên `ws_notices`, mới nhất trước |
| `GET /api/directory` — đọc danh bạ | `exchangeUserToken` → `listDirectoryUnitType` / `listDirectoryUnit` / `listDirectoryGroup` / `listDirectoryMember` (chỉ người dùng có quyền quản trị danh bạ — nhân viên thường bị 403) |

Ví dụ đầy đủ yêu cầu/phản hồi cho từng ngữ cảnh nằm trong các fixture tại `examples/api/` (bảng ở phần sau).

## Khoảng trống DX-OS

Đối chiếu với hợp đồng pinned `3e0ce51` và [điều kiện phát hành Tầng 1](https://github.com/vku2-open-source-2026/junctura-dxos/issues/50): những phần DX-OS đã hỗ trợ và những phần còn thiếu hoặc chưa đạt nghiệm thu như sau. Hợp đồng này được viết để không phụ thuộc phần còn thiếu; runtime của các phần đền bù được theo dõi ở các issue tính năng.

| # | Khoảng trống | Bằng chứng từ hợp đồng pinned | Cách hợp đồng Workspace xử lý |
| --- | --- | --- | --- |
| 1 | **Không có lệnh liệt kê execution** — `/v1/workflows/executions` chỉ có `POST`; không có `GET /v1/workflows/executions` để liệt kê hồ sơ theo đơn vị/trạng thái | `paths` chỉ khai báo `post` cho `/v1/workflows/executions`; `GET` chỉ có ở `/v1/workflows/executions/{executionId}` | Danh sách hồ sơ đọc từ bản chiếu `ws_cases` qua `/v2/data`; trạng thái chuẩn vẫn lấy từ từng execution. Rủi ro lệch bản chiếu được ghi ở phần nguồn dữ liệu |
| 2 | **Directory không có tìm theo tên** — các lệnh liệt kê directory (`GET /v1/directory/units`, `GET /v1/directory/unit-types`, …) chỉ nhận `limit`/`cursor`; `GET /v1/search` chỉ phủ bản ghi và tệp văn bản sạch, không phủ đơn vị/người | Tham số của bốn lệnh directory liệt kê chỉ gồm `PlannedLimit`, `PlannedCursor` | `GET /api/directory` nhận `q` và Workspace tự lọc theo tên trên các trang directory; số trang phải quét tỉ lệ với số kết quả |
| 3 | **Quét hộp việc có trần** — mỗi lệnh `GET /v1/workflows/tasks` chỉ quét tối đa 20 trang × 100 task đang hoạt động trước khi lọc đơn vị/nhóm/quá hạn | Mô tả `listWorkflowTasks` | Hợp đồng giữ phân trang cursor bình thường nhưng ghi nhận: hộp việc quá lớn có thể hết cursor sớm; việc hiển thị "quá hạn" phụ thuộc lọc sau quét |
| 4 | **Metadata tệp không có tên gốc** — `ObjectMetadata` của `/v2/objects` chỉ gồm `id`, `size`, `recordRef`, `tags` | Schema `ObjectMetadata` | Tên gốc và loại tệp nằm trong bản ghi `ws_case_files` ghi ngay sau upload; hai lần ghi này không nguyên tố — sự cố giữa chừng để lại một object chưa vào danh sách và được đối soát theo hạn mức, không bao giờ lộ tệp không có bản ghi metadata |
| 5 | **Lọc theo trường đòi schema chỉ mục** — `where` của `GET /v2/data/{collection}` chỉ nhận trường đã khai báo chỉ mục qua `PUT /v2/data-schemas/{collection}` | Mô tả tham số `where` và `sort` | `pack:install` (issue #12) đăng ký schema các bộ sưu tập `ws_*` kèm chỉ mục (`executionId`, `caseId`, `createdAt`, …) trước khi API mới tiếp nhận lưu lượng; cho đến khi đó, hợp đồng yêu cầu bộ lọc danh sách chỉ dùng trường đã chỉ mục |
| 6 | **Bearer ủy quyền ngắn hạn** — token đổi qua `/v1/token-exchange` có `expires_in` 1–60 giây | Schema phản hồi `exchangeUserToken` | Mỗi yêu cầu của app Tầng 3 đổi mới một bearer, không cache trên giây; chi phí một lần gọi thêm mỗi lượt là chấp nhận được cho đúng đắn |
| 7 | **Directory list đòi quản trị viên danh bạ** — bốn lệnh liệt kê directory của DX-OS đều yêu cầu "enrolled tenant directory administrator"; token nhân viên thường bị từ chối | Mô tả các lệnh `listDirectoryUnitType` / `listDirectoryUnit` / `listDirectoryGroup` / `listDirectoryMember` pinned (thẻ `application-admin`) | `GET /api/directory` chỉ phục vụ người dùng có quyền quản trị danh bạ; nhân viên thường nhận 403 `forbidden`. Workspace giữ đúng phạm vi người dùng — không fallback sang định danh app để mở quyền; thực thi ở runtime được theo dõi ở issue #9 và issue #19 |

Không có khoảng trống nào chặn việc đóng băng hợp đồng: cả bảy đều có cách xử lý trong hợp đồng và phần đền bù nằm ở runtime hoặc issue tính năng, không phải sửa DX-OS trong issue này.

## Kiểm tra hợp đồng

Kiểm tra tái dùng đúng mẫu dev-only của [`scripts/check-pack-schemas.py`](../scripts/check-pack-schemas.py): JSON Schema draft 2020-12 qua `jsonschema` của Python, pin giống `requirements-contracts.txt`, một lệnh từ checkout sạch, không phụ thuộc production:

```sh
python -m pip install -r requirements-contracts.txt
python scripts/check-api-contract.py
```

Lệnh kiểm hợp đồng `docs/contracts/workspace-api.openapi.json` và 21 fixture dưới `examples/api/`:

- Hợp đồng là OpenAPI 3.1.x hợp lệ, `operationId` không trùng, mọi `$ref` nội bộ trỏ tới được, mọi schema thành phần là draft 2020-12 hợp lệ, mọi response khai báo representation JSON.
- Fixture **thành công** và **gửi lại**: thân yêu cầu khớp schema của thao tác; thân phản hồi khớp schema của mã trạng thái tương ứng.
- Fixture **thiếu quyền**: phản hồi 403 với đúng mã lỗi (`forbidden`, `task_group_required`).
- Fixture **đầu vào lỗi**: thân yêu cầu bị schema của thao tác từ chối và phản hồi ghi 400 `invalid_input`.
- Quy tắc phát lại: fixture `replay` dùng lại key với cùng thân và ghi đúng một phản hồi đầu tiên; fixture `replay-conflict` dùng lại key với thân khác và ghi 409/422 `idempotency_key_reused`.
- Phủ rộng: mỗi thao tác có ít nhất một fixture thành công; mỗi thao tác `POST` có ít nhất một fixture tiêu cực; thao tác `POST` có key bắt buộc phải có đủ cặp replay.

| Fixture | Ngữ cảnh |
| --- | --- |
| `createCase.success\|replay\|replay-conflict\|forbidden\|invalid-input.json` | Mở hồ sơ: thành công, gửi lại, gửi lại lệch key, thiếu nhóm gửi, thiếu trường bắt buộc |
| `listCases.success.json` | Trang hồ sơ, `nextCursor: null` |
| `getCase.success\|forbidden.json` | Xem hồ sơ của đơn vị mình; đơn vị ngoài bị 403 |
| `attachCaseFile.success\|invalid-input.json` | Đính kèm tệp (multipart, không kiểm JSON); tên tệp không hợp lệ |
| `listTasks.success.json` | Việc hôm nay, có bước quá hạn và người giữ claim |
| `completeTask.success\|replay\|replay-conflict\|forbidden\|conflict\|invalid-input\|invalid-collection.json` | Hoàn tất bước kèm `records`; gửi lại, gửi lại lệch key, thiếu nhóm, xung đột claim, thiếu quyết định, dùng bộ sưu tập ngoài danh mục |
| `listNotices.success.json` | Bảng tin, có thông báo ghim |
| `listDirectory.success\|forbidden.json` | Danh bạ với bộ lọc `q`; nhân viên thường thiếu quyền quản trị danh bạ bị 403 |

Lệnh thoát khác 0 kèm từng vi phạm (đường dẫn JSON kèm thông báo) khi có lỗi. CI chạy bước này ngay sau bước kiểm schema gói ngành.

## Ngoài phạm vi

Issue này chỉ đóng băng hợp đồng và kiểm tra hợp đồng: **không** thêm route server, **không** thay đổi DX-OS, **không** cài bộ đọc gói. Runtime của từng thao tác được theo dõi ở các issue tính năng tương ứng trong [PLAN.md](PLAN.md).
