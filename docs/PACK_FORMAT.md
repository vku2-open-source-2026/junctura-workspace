<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Định dạng gói ngành Junctura Workspace (v1)

Gói ngành là thứ cung cấp nhãn, vai trò, nhóm, loại đơn vị, loại hồ sơ, biểu mẫu và quy trình cho Workspace. Gói gồm ba thành phần nằm trong một thư mục:

```text
<pack-id>/
  pack.json             Bản kê khai gói: nhãn, nhóm, loại đơn vị, loại hồ sơ, quy trình, cách mở hồ sơ và bước xử lý
  units.json            Đơn vị mẫu dùng khi cài gói lên một stack trống
  workflows/*.bpmn20.xml  Quy trình BPMN 2.0, một tệp cho mỗi quy trình
```

Cặp gói mẫu của Workspace nằm ở `examples/packs/education/` (Giáo dục) và `examples/packs/health/` (Y tế). Cả hai chỉ chứa dữ liệu tổng hợp, không có người hay đơn vị thật. Gói Y tế thật của Junctura Health vẫn giữ ở kho `junctura-health` theo [PLAN.md](PLAN.md) và phải tuân theo đặc tả này.

## Kiểm tra hợp đồng

Kiểm tra dùng chuẩn JSON Schema draft 2020-12 qua `jsonschema` của Python, pin giống mẫu `requirements-contracts.txt` của Junctura DX-OS. Một lệnh duy nhất chạy được từ checkout sạch:

```sh
python -m pip install -r requirements-contracts.txt
python scripts/check-pack-schemas.py
```

Lệnh này chỉ là kiểm tra mức dev, không có phụ thuộc production: nó kiểm hai schema trong `schemas/` là draft 2020-12 hợp lệ, kiểm `pack.json` và `units.json` của mọi gói trong `examples/packs/`, rồi chạy thêm các ca hợp đồng âm để chứng minh schema từ chối: thiếu trường bắt buộc, `formatVersion` không được hỗ trợ, `outcome` ngoài miền và `options` không đúng chỗ hoặc thiếu trên trường `select`. Lệnh thoát khác 0 kèm từng vi phạm (đường dẫn JSON kèm thông báo) khi có lỗi. CI chạy bước này sau kiểm tra REUSE/SPDX và Compose, trước các bước backend và giao diện.

## Quan hệ với Directory

Workspace lưu đơn vị, loại đơn vị, thành viên và nhóm ở Directory (Keycloak groups). Gói khai báo những gì sẽ tồn tại trong Directory khi cài:

- `groups[]` — nhóm vai trò xử lý hồ sơ; `pack:install` tạo nhóm tương ứng trong Directory. Quyền đọc/ghi hồ sơ của từng bước được kiểm qua nhóm này.
- `unitTypes[]` — loại đơn vị trong ngành; `pack:install` tạo loại đơn vị tương ứng trong Directory.
- `units.json` — đơn vị mẫu được `pack:install` tạo qua API Directory trên stack trống; người dùng thêm đơn vị thật sau khi cài.

ID nhóm trong gói chính là ID nhóm dùng trong Directory và Keycloak, nên cài lại hoặc nâng phiên bản gói phải tái sử dụng đúng nhóm đã tạo.

## `pack.json`

| Trường | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `formatVersion` | Có | Phải là `1` với đặc tả này. Bộ đọc gói từ chối phiên bản khác thay vì đoán. |
| `id` | Có | Định danh gói, ổn định vĩnh viễn (ví dụ `education`). Không đổi khi nâng phiên bản. |
| `version` | Có | Chuỗi phiên bản `X.Y.Z` kèm tiền phát tùy chọn (ví dụ `0.1.0-rc.1`), theo mẫu kiểm trong schema. |
| `name`, `description` | `name` | Nhãn hiển thị của gói. |
| `language` | Có | Ngôn ngữ của mọi nhãn trong gói, hai chữ cái (ví dụ `vi`). |
| `unitsFile` | Có | Tên tệp danh mục đơn vị; v1 cố định là `units.json`. |
| `groups` | Có | Nhóm vai trò, xem [Quan hệ với Directory](#quan-hệ-với-directory). |
| `unitTypes` | Có | Loại đơn vị trong ngành (bệnh viện, trường học…). |
| `recordTypes` | Có | Loại hồ sơ của gói. |
| `workflows` | Có | Danh sách quy trình, mỗi quy trình một tệp BPMN. |

Quy trình (`workflows[]`) khai báo phía gửi/nhận bằng cả loại đơn vị lẫn nhóm vai trò:

| Trường | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `id` | Có | Định danh ổn định của quy trình, trùng `process/@id` trong tệp BPMN. |
| `name`, `description` | `name` | Nhãn hiển thị của quy trình. |
| `recordType` | Có | Trỏ tới `recordTypes[].id`. |
| `bpmn` | Có | Đường dẫn tương đối tới tệp BPMN, phần mở rộng `.bpmn20.xml` như Junctura Health và DX-OS đang dùng (còn nhận `.bpmn`). |
| `senderUnitTypes` | Có | Loại đơn vị được mở hồ sơ. |
| `receiverUnitTypes` | Có | Loại đơn vị nhận và xử lý hồ sơ. |
| `senderGroups` | Có | Nhóm vai trò phía đơn vị gửi; nhóm trong `open` phải thuộc đây. |
| `receiverGroups` | Có | Nhóm vai trò phía đơn vị nhận. |
| `open` | Có | Cách mở hồ sơ, xem [Mở hồ sơ và xử lý bước](#mở-hồ-sơ-và-xử-lý-bước). |
| `steps` | Có | Các bước xử lý, theo thứ tự trình bày trong manifest; luồng thật nằm trong BPMN. |

Bước xử lý (`steps[]`) — mô tả nhãn, vai trò, hạn, biểu mẫu và quyết định của từng bước:

| Trường | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `id` | Có | Định danh ổn định của bước, khớp một `userTask` trong BPMN. |
| `name` | Có | Nhãn hiển thị của bước. |
| `role` | Có | Nhóm vai trò phụ trách bước, trỏ tới `groups[].id`, thuộc `senderGroups` hoặc `receiverGroups`. |
| `unitTypes` | Có | Loại đơn vị thực hiện bước, phải nằm trong `senderUnitTypes ∪ receiverUnitTypes`. |
| `deadlineDays` | Có | Số ngày lịch tối đa để hoàn tất bước (1–90), xem [Hạn xử lý](#hạn-xử-lý). |
| `form` | Không | Biểu mẫu của bước: `fields[]` với `id`, `label`, `type` (`text`, `text-multiline`, `number`, `date`, `select`, `file`), `required` và `options` (chỉ dành cho `select`). |
| `decisions` | Có | Các lựa chọn khi hoàn tất bước: `id`, `label`, `outcome` (`approve`, `reject`, `forward`, `request-info`) và `requiresReason`. |

Schema tự kiểm các điều kiện một tài liệu có thể biểu diễn: `reject` hoặc `request-info` bắt buộc `requiresReason: true`, `select` bắt buộc có `options`, type khác cấm `options`. Quỹ đạo hoàn tất một bước luôn là một quyết định kèm lý do khi `requiresReason`, nên Workspace lưu đủ dấu vết.

## Mở hồ sơ và xử lý bước

`workflows[].open` mô tả cách một hồ sơ được tạo, tách khỏi các bước xử lý về sau:

- **Mở hồ sơ**: một thành viên thuộc `open.role` ở đơn vị gửi (trong `senderUnitTypes`, giới hạn thêm bởi `open.unitTypes` nếu khai báo) điền `open.form` để tạo hồ sơ theo `recordType`. Mở hồ sơ là gửi biểu mẫu ban đầu, không có quyết định.
- **Xử lý bước**: các `steps[]` diễn ra về sau, chủ yếu ở đơn vị nhận; người thuộc `role` điền `steps[].form` và chọn một `steps[].decisions` để hoàn tất.

Đơn vị gửi và đơn vị nhận được định nghĩa tường minh bằng `senderUnitTypes`/`receiverUnitTypes` cho loại đơn vị và `senderGroups`/`receiverGroups` cho nhóm vai trò, tách bạch hai chiều này: một loại đơn vị có thể vừa gửi vừa nhận (ví dụ trường học trong quy trình cấp bản sao), nhưng nhóm vai trò phía gửi và phía nhận là những nhóm khác nhau.

## `units.json`

| Trường | Bắt buộc | Ý nghĩa |
| --- | --- | --- |
| `formatVersion` | Có | Phải là `1`, khớp `pack.json`. |
| `units[]` | Có | Đơn vị mẫu: `id`, `unitType` (trỏ tới `unitTypes` của `pack.json`), `name` và `parent` (trỏ tới một đơn vị trong cùng tệp, `null` nếu là gốc). |

Đơn vị mẫu chỉ để cài dữ liệu ban đầu qua `pack:install`; người dùng sẽ thêm đơn vị thật sau khi cài.

## ID và phiên bản

- Mọi `id`, kể cả `id` của gói, dùng cùng một quy tắc định danh ổn định: chữ thường, số và gạch ngang, bắt đầu bằng chữ cái, dài tối đa 63 ký tự (`^[a-z][a-z0-9-]{0,62}$`).
- ID ổn định vĩnh viễn: đổi nhãn thoải mái, đổi ID là gói khác. `pack:install` dùng ID để nhận diện khi nâng phiên bản, nên nâng phiên bản trong cùng ID sẽ cập nhật tại chỗ, không nhân đôi loại đơn vị hay nhóm. ID mới chỉ được thêm; ID đã phát hành không được tái sử dụng cho ý nghĩa khác.
- `version` là chuỗi `X.Y.Z` với tiền phát tùy chọn theo mẫu trong schema; schema chỉ kiểm dạng chuỗi, thứ tự phiên bản do bộ đọc gói so sánh khi nâng cấp (issue #8).

## Hạn xử lý

`deadlineDays` là số ngày lịch, xác định không phụ thuộc múi giờ hay lịch làm việc: hạn tuyệt đối của bước = mốc thời gian bước mở + `deadlineDays` × 24 giờ, tính theo UTC, được Workspace ghi lại ngay khi bước mở. Đặc tả không định nghĩa lịch ngày làm việc; nếu một ngành cần quy ước khác, đó là việc của phiên bản định dạng sau.

## BPMN

- Mỗi quy trình một tệp BPMN 2.0 với phần mở rộng `.bpmn20.xml`, đặt tên như các tệp trong `junctura-health/workflows/` và DX-OS; schema còn nhận `.bpmn` cho gói cũ.
- Tệp khai báo `process/@id` trùng `workflows[].id`.
- Chưa cần phần tử điều kiện hay gateway trong v1; các quyết định của bước được khai báo trong `steps[].decisions` và nạp vào Workspace làm lựa chọn hoàn tất việc.

## Kiểm tra chéo của bộ đọc gói (issue #8)

Schema một tài liệu không biểu diễn được (hoặc không nên biểu diễn) các bất biến giữa tệp và giữa các phần tử trong một mảng. Những kiểm tra sau thuộc bộ đọc gói ở issue #8, không phải lệnh kiểm schema ở trên:

1. Mảng `groups`, `unitTypes`, `recordTypes`, `workflows` không có `id` trùng; `steps`, `decisions`, `fields` cũng vậy trong phạm vi cha của chúng.
2. `workflows[].recordType` phải là một `recordTypes[].id`.
3. `workflows[].bpmn` phải là tệp thật trong thư mục gói và có `process/@id` trùng `workflows[].id`.
4. Mọi phần tử của `senderUnitTypes`, `receiverUnitTypes`, `senderGroups`, `receiverGroups`, `open.role`, `steps[].role`, `steps[].unitTypes`, `open.unitTypes` phải trỏ tới một phần tử tương ứng của gói; `steps[].unitTypes` là con tập của `senderUnitTypes ∪ receiverUnitTypes` và nhóm trong `open` phải thuộc `senderGroups`.
5. `units[].unitType` phải là một `unitTypes[].id`; `units[].parent` phải là một `units[].id` trong cùng tệp, không tạo chu trình, và cây có đúng một gốc.
6. `pack.json` và `units.json` phải cùng `formatVersion`; khi nâng cấp, `version` mới phải lớn hơn `version` cũ.

## Schema

Schema JSON có phiên bản nằm ở `schemas/pack.schema.json` và `schemas/units.schema.json` (draft 2020-12), là nguồn sự thật cho cấu trúc từng tài liệu. Lệnh `scripts/check-pack-schemas.py` nạp hai schema này qua `jsonschema.Draft202012Validator`, không cài lại logic kiểm schema trong code.
