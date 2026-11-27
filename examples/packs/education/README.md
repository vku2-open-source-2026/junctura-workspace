<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Gói Giáo dục (`education`)

Gói mẫu cho ngành giáo dục, chỉ chứa dữ liệu tổng hợp, không có người hay đơn vị thật:

- **Đơn vị mẫu** (`units.json`): một Phòng Giáo dục (`phong-giao-duc-huyen-a`) và hai trường (`truong-tieu-hoc-a1`, `truong-thcs-a2`) thuộc phòng đó.
- **Nhóm vai trò**: `van-thu` (tiếp nhận/trả kết quả), `hoc-vu` (mở hồ sơ, phản hồi) và `lanh-dao` (xét duyệt).
- **Hai loại hồ sơ và hai quy trình** (khóa định nghĩa quy trình là `workflows[].id`, trùng `process/@id` trong BPMN — đây là các definition key mà `pack:install` (issue #12) nạp lên engine):
  - `chuyentruuong` (loại hồ sơ `chuyen-truong`) — trường gửi, phòng giáo dục tiếp nhận (`van-thu`, 2 ngày) → xét duyệt (`lanh-dao`, 5 ngày) → thông báo kết quả về trường cũ (`hoc-vu` phía trường, 3 ngày). Từ chối ở tiếp nhận hoặc xét duyệt kết thúc hồ sơ.
  - `capbansaohocba` (loại hồ sơ `cap-ban-sao-hoc-ba`) — trường tự xử lý: tiếp nhận yêu cầu (`hoc-vu`, 2 ngày) → cấp bản sao (`lanh-dao`, 5 ngày). `yeu-cau-bo-sung` (request-info) quay lại bước tiếp nhận để bổ sung giấy tờ rồi nộp lại.

## Khác bản nháp trước đây

Bản nháp chỉ khai `userTask` trần trong BPMN, không có luồng. Bản chạy được bổ sung theo [chính sách BPMN pinned của DX-OS](https://github.com/vku2-open-source-2026/junctura-dxos/blob/3e0ce519530057f47112f1a6b4f544202deb8bd9/src/modules/workflow/definition-policy.mjs) và mẫu đã kiểm `sample-two-step`:

- luồng nối liền `startEvent → userTask → exclusiveGateway → endEvent` bằng `sequenceFlow`, mọi `sourceRef`/`targetRef` đều trỏ tới node đã khai;
- vai trò gắn qua `flowable:candidateGroups`, đúng bằng nhóm `steps[].role` của manifest;
- mọi quyết định nhiều lựa chọn đều có nhánh gateway đi được, điều kiện dạng `${decision == '<decision-id>'}` — cùng biến `decision` mà hợp đồng hoàn tất việc (`POST /api/tasks/{taskId}/complete`) gửi đi; nhánh `reject` kết thúc ở `endEvent` riêng, `request-info` quay lại bước tiếp nhận;
- `<documentation>` của từng `userTask` ghi lại hạn xử lý (`deadlineDays`) và nhóm phụ trách, khớp manifest — được kiểm tự động trong `server/tests/education-pack.test.mjs`.

ID ổn định giữ nguyên so với bản nháp (gói, nhóm, loại đơn vị, loại hồ sơ, bước, quyết định, đơn vị mẫu) — ID ổn định vĩnh viễn theo [PACK_FORMAT.md](../../../docs/PACK_FORMAT.md); chỉ `version` tăng lên `0.2.0` khi nội dung gói thay đổi. Ngoại lệ duy nhất là khóa quy trình: `workflows[].id` và `process/@id` chuyển từ `chuyen-truong`/`cap-ban-sao-hoc-ba` sang `chuyentruong`/`capbansaohocba` — giao của schema stableId Workspace với [chính sách BPMN pinned của DX-OS (`validateDefinition`)](https://github.com/vku2-open-source-2026/junctura-dxos/blob/3e0ce519530057f47112f1a6b4f544202deb8bd9/src/modules/workflow/definition-policy.mjs). Quy tắc khóa gọn một dòng: Workspace và DX-OS cùng nhận khóa gồm chữ thường và chữ số; DX-OS cho thêm gạch dưới (`_`) còn định dạng v1 của Workspace cho thêm gạch ngang (`-`), và hai khóa của gói (`chuyentruong`, `capbansaohocba`) chỉ dùng các ký tự chung, nên nạp thẳng lên engine mà không cần ánh xạ. Tên tệp BPMN không đổi.

## Seed dữ liệu mẫu qua API

Gói chỉ là nội dung; toàn bộ dữ liệu demo nạp qua API trên stack đã cài gói, không seed trực tiếp cơ sở dữ liệu. Lời gọi mẫu dưới đây bám hợp đồng Tầng 3 trong [API.md](../../../docs/API.md) (fixture tại `examples/api/`):

1. **Cài gói** bằng `pack:install` (issue #12, ngoài phạm vi thư mục gói này): tạo loại đơn vị, nhóm và ba đơn vị mẫu trong Directory, nạp hai quy trình BPMN.
2. **Gán nhân sự vào nhóm** qua API Directory của DX-OS, ví dụ một nhân viên nhóm `van-thu` và một nhóm `lanh-dao` ở `phong-giao-duc-huyen-a`, một nhân viên nhóm `hoc-vu` ở mỗi trường.
3. **Mở hồ sơ chuyển trường** — người nhóm `hoc-vu` ở trường gửi:

   ```http
   POST /api/cases
   Idempotency-Key: <uuid>
   {
     "recordType": "chuyen-truong",
     "receiverUnit": "phong-giao-duc-huyen-a",
     "subject": "Nguyễn Văn An",
     "urgency": "Thường",
     "input": {
       "ho-ten-hoc-sinh": "Nguyễn Văn An",
       "lop-hien-tai": "5A",
       "truong-chuyen-den": "Tiểu học A1"
     }
   }
   ```

   `input` là giá trị của `open.form`; `Idempotency-Key` bắt buộc cho `POST /api/cases`.
4. **Xử lý bước tiếp nhận** — người nhóm `van-thu` của phòng giáo dục đọc việc qua `GET /api/tasks` rồi hoàn tất:

   ```http
   POST /api/tasks/{taskId}/complete
   Idempotency-Key: <uuid>
   {
     "decision": "tiep-nhan",
     "form": { "ghi-chu-tiep-nhan": "Đã nhận đủ giấy tờ" },
     "records": [
       { "collection": "ws_case_notes", "data": { "caseId": "<caseId>", "text": "Đã tiếp nhận" } }
     ]
   }
   ```

   Phản hồi `202` nghĩa là bước đang chờ chuyển qua outbox — đọc lại hồ sơ và lịch sử để thấy bước kế. Từ chối dùng `"decision": "tu-choi-tiep-nhan"` kèm `reason` bắt buộc (`requiresReason`).
5. **Hoàn tất vòng cấp bản sao học bạ**: mở hồ sơ với `recordType: "cap-ban-sao-hoc-ba"`, receiverUnit là chính trường gửi; ở bước cấp bản sao chọn `"yeu-cau-bo-sung"` kèm lý do để hồ sơ quay lại bước tiếp nhận (nhánh request-info), bổ sung rồi chọn `"dong-y-cap"` với `form` gồm `so-vao-so`, `ngay-cap` và tệp `ban-sao-hoc-ba`.

Không có người dùng thật nào được tạo trong kho này; danh sách nhân sự demo trên stack demo do cấu hình triển khai quyết định.

## Ranh giới với issue #12 và #27

- **Issue này** chỉ chỉnh nội dung gói trong kho Workspace: `pack.json`, `units.json`, hai tệp BPMN và preflight đọc gói `readPack()` đã có từ issue #8. Không route server, không cài đặt, không nạp engine.
- **Issue #12 (`pack:install`)** sở hữu cài đặt: tạo `unitTypes`/`groups`/đơn vị mẫu qua API Directory, kiểm "phiên bản mới phải lớn hơn", đăng ký schema các bộ sưu tập `ws_*` kèm chỉ mục và nạp BPMN lên engine — dùng ngay definition key của gói (`chuyentruong`, `capbansaohocba`, đã khớp `process/@id`) vì hai key này vượt qua `validateDefinition()` của chính sách BPMN pinned; không cần ánh xạ thêm khi nạp.
- **Issue #27 (nghiệm thu stack thật)** sở hữu chạy được: hai quy trình chạy trên Flowable/DX-OS với claim đúng theo `candidateGroups`, `dueAt` ghi đúng `deadlineDays × 24 giờ` theo UTC, quyết định chuyển đúng nhánh gateway, vòng `request-info` quay lại bước tiếp nhận, và luồng seed ở phần trên chạy trọn trên stack trống.
