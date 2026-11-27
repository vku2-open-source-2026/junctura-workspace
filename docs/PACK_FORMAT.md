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
- `version` là chuỗi `X.Y.Z` với tiền phát tùy chọn theo mẫu trong schema; schema chỉ kiểm dạng chuỗi, còn kiểm "phiên bản mới phải lớn hơn" khi nâng cấp thuộc `pack:install` (issue #12), không phải bộ đọc gói.

## Hạn xử lý

`deadlineDays` là số ngày lịch, xác định không phụ thuộc múi giờ hay lịch làm việc: hạn tuyệt đối của bước = mốc thời gian bước mở + `deadlineDays` × 24 giờ, tính theo UTC, được Workspace ghi lại ngay khi bước mở. Đặc tả không định nghĩa lịch ngày làm việc; nếu một ngành cần quy ước khác, đó là việc của phiên bản định dạng sau.

## BPMN

- Mỗi quy trình một tệp BPMN 2.0 với phần mở rộng `.bpmn20.xml`, đặt tên như các tệp trong `junctura-health/workflows/` và DX-OS; schema còn nhận `.bpmn` cho gói cũ.
- Tệp khai báo `process/@id` trùng `workflows[].id`, và `process` phải là con trực tiếp của `definitions`.
- Các `userTask` khớp `steps[].id` phải nằm trong `process` — con trực tiếp hay qua BPMN subprocess đều được; `userTask` ở ngoài `process` không đếm để khớp manifest.
- Chưa cần phần tử điều kiện hay gateway trong v1; các quyết định của bước được khai báo trong `steps[].decisions` và nạp vào Workspace làm lựa chọn hoàn tất việc.

## Kiểm tra chéo của bộ đọc gói (issue #8)

Schema một tài liệu không biểu diễn được (hoặc không nên biểu diễn) các bất biến giữa tệp và giữa các phần tử trong một mảng. Những kiểm tra sau thuộc bộ đọc gói ở issue #8, không phải lệnh kiểm schema ở trên; hợp đồng kết quả và lỗi của bộ đọc nằm ở phần [Bộ đọc gói và preflight](#bộ-đọc-gói-và-preflight-issue-8):

1. Mảng `groups`, `unitTypes`, `recordTypes`, `workflows` không có `id` trùng; `steps`, `decisions`, `fields` cũng vậy trong phạm vi cha của chúng.
2. `workflows[].recordType` phải là một `recordTypes[].id`.
3. `workflows[].bpmn` phải là tệp thật trong thư mục gói và có `process/@id` trùng `workflows[].id`.
4. Mọi phần tử của `senderUnitTypes`, `receiverUnitTypes`, `senderGroups`, `receiverGroups`, `open.role`, `steps[].role`, `steps[].unitTypes`, `open.unitTypes` phải trỏ tới một phần tử tương ứng của gói; `steps[].unitTypes` là con tập của `senderUnitTypes ∪ receiverUnitTypes` và nhóm trong `open` phải thuộc `senderGroups`.
5. `units[].unitType` phải là một `unitTypes[].id`; `units[].parent` phải là một `units[].id` trong cùng tệp, không tạo chu trình, và cây có đúng một gốc.
6. `pack.json` và `units.json` phải cùng `formatVersion`; khi nâng cấp, `version` mới phải lớn hơn `version` cũ.

## Schema

Schema JSON có phiên bản nằm ở `schemas/pack.schema.json` và `schemas/units.schema.json` (draft 2020-12), là nguồn sự thật cho cấu trúc từng tài liệu. Lệnh `scripts/check-pack-schemas.py` nạp hai schema này qua `jsonschema.Draft202012Validator`, không cài lại logic kiểm schema trong code.

## Bộ đọc gói và preflight (issue #8)

Bộ đọc gói nằm ở `server/packs.mjs`, là một hàm preflight thuần túy dùng chung cho `pack:install` và thư viện loại hồ sơ: `readPack(packDir)` chỉ đọc gói từ đĩa — không gọi API, không ghi trạng thái, không truy cập mạng, không cơ sở dữ liệu, không xác thực. Mỗi lần gọi đọc lại từ đầu và trả kết quả như nhau.

Hợp đồng kết quả:

- Thành công: `{ ok: true, pack }` — `pack.manifest` và `pack.units` là `pack.json`/`units.json` đã parse, giữ nguyên dữ liệu; `pack.workflows[]` theo thứ tự manifest, mỗi quy trình có `id`, `bpmn` (đường dẫn như trong manifest), `processId`, `userTaskIds` (các `userTask` trong `process`, theo thứ tự văn bản) và `xml` (nguyên văn nội dung BPMN để bộ cài nạp lên engine).
- Thất bại: `{ ok: false, errors }` — mỗi lỗi có `code` (mã ổn định, bảng dưới), `file` (đường dẫn trong gói: `pack.json`, `units.json`, tệp BPMN, hoặc `.` cho chính thư mục gói), `path` (JSON pointer RFC 6901 với tệp JSON, locator kiểu XPath với BPMN, rỗng với lỗi cấp tệp) và `message`. Bộ đọc gom càng nhiều lỗi độc lập càng tốt: manifest hỏng schema thì dừng các đọc phụ thuộc, còn `units.json` và BPMN được kiểm độc lập với nhau.

| `code` | Khi nào |
| --- | --- |
| `PACK_DIR_UNREADABLE` | Thư mục gói thiếu hoặc không phải thư mục. |
| `PACK_MANIFEST_ESCAPE` / `PACK_UNITS_ESCAPE` / `PACK_BPMN_ESCAPE` | Đường dẫn tham chiếu vượt ra ngoài thư mục gói, kể qua symlink. |
| `PACK_MANIFEST_UNREADABLE` / `PACK_UNITS_UNREADABLE` | Tệp thiếu hoặc không parse được JSON. |
| `PACK_MANIFEST_INVALID` / `PACK_UNITS_INVALID` | Vi phạm schema, một lỗi cho mỗi vi phạm, kèm JSON pointer. |
| `PACK_DUPLICATE_ID` | `id` trùng trong cùng phạm vi: mảng gốc của `pack.json`, `units[]`, `steps` trong một quy trình, `decisions` trong một bước, `fields` trong một biểu mẫu. |
| `PACK_REF_NOT_FOUND` | Tham chiếu trỏ tới id không tồn tại trong mảng đích (`recordType`, `unitTypes`, `groups`, các vai trò, `parent`). |
| `PACK_OPEN_ROLE_NOT_SENDER` | `open.role` là nhóm thật nhưng không thuộc `senderGroups`. |
| `PACK_OPEN_UNIT_TYPE_NOT_ALLOWED` | `open.unitTypes` là loại đơn vị thật nhưng không thuộc `senderUnitTypes`. |
| `PACK_STEP_ROLE_NOT_IN_WORKFLOW` | `steps[].role` là nhóm thật nhưng không thuộc `senderGroups` hay `receiverGroups`. |
| `PACK_STEP_UNIT_TYPE_NOT_ALLOWED` | `steps[].unitTypes` là loại đơn vị thật nhưng không thuộc `senderUnitTypes ∪ receiverUnitTypes`. |
| `PACK_UNIT_CYCLE` | Chuỗi `parent` tạo chu trình. |
| `PACK_UNIT_TREE_INVALID` | Cây đơn vị không có đúng một gốc. |
| `PACK_BPMN_MISSING` / `PACK_BPMN_UNREADABLE` | Tệp BPMN thiếu, là vòng lặp symlink hoặc không phải tệp thường. |
| `PACK_BPMN_XML_INVALID` | XML hỏng, có DOCTYPE/DTD, root không phải `definitions` trong namespace BPMN 2.0, `process` không là con trực tiếp của `definitions`, không có đúng một `process` (có `@id`), hoặc id `userTask` thiếu/trùng. |
| `PACK_BPMN_PROCESS_ID_MISMATCH` | `process/@id` khác `workflows[].id`. |
| `PACK_BPMN_STEP_MISMATCH` | `steps[].id` và id `userTask` trong `process` không khớp theo cả hai chiều: mỗi bước có một `userTask` trong `process` và mọi `userTask` trong `process` có một bước. |

Module cũng xuất `PackReadErrorCode` (bảng mã trên). Nửa "hai tệp cùng `formatVersion`" của kiểm 6 được schema ghim bằng `const 1`; nửa "phiên bản mới phải lớn hơn" khi nâng cấp không thuộc bộ đọc — `pack:install` (issue #12) tự kiểm trên hai manifest khi cài, và bộ đọc cố tình không cài bộ so sánh phiên bản.

Cách bộ đọc thực hiện: cấu trúc từng tài liệu được kiểm bằng schema draft 2020-12 thật, nạp trực tiếp `schemas/*.schema.json` qua `Ajv2020` (`allErrors: true`), không cài lại logic schema; BPMN được parse namespace-aware bằng `saxes` và từ chối mọi DOCTYPE/DTD nên không có tham chiếu ngoài nào được nạp hay phân giải; containment của `pack.json`, `units.json` và mọi tệp BPMN được chứng minh trước khi mở tệp, symlink nằm trong gói thì được theo, vượt gói thì từ chối.

## Lệnh `pack:install --dry-run` (issue #12)

Lệnh cài gói nằm ở `scripts/pack-install.mjs`; đợt đầu tiên chỉ bật chế độ dry-run, kế hoạch lập từ kết quả của bộ đọc gói ở trên:

```sh
node scripts/pack-install.mjs examples/packs/education --dry-run
npm run pack:install --prefix server -- ../examples/packs/education --dry-run
```

Lệnh **chỉ đọc**: kiểm gói trước (`readPack()`), không gọi HTTP, không ghi tệp, không cần cấu hình hay token; kế hoạch in ra stdout là JSON ổn định từng byte giữa các lần chạy (không có mốc thời gian). Nhóm và đơn vị giữ nguyên ID khai báo trong gói, nên chạy lại kế hoạch cài thật sẽ trỏ đúng tài nguyên đã tạo, không nhân đôi. Các bước `planned` mang hai loại chặn khác nhau: mỗi bước nạp BPMN chờ `blockedBy: "junctura-dxos#112"` vì Core chưa ghim thao tác triển khai định nghĩa nào (`/v1/workflows/definitions` chỉ đọc); còn `ws_packs.schema.register` và `ws_packs.packRecord.write` chờ `blockedBy: "junctura-workspace#12"` — endpoint data-schema của Core đã được ghim (`PUT /v2/data-schemas/{collection}`, thao tác `registerCollectionSchema`), cái còn thiếu là *thiết kế schema của `ws_packs`* do issue #12 chưa cung cấp. Mọi bước planned **không** có `method`/`path` — kế hoạch không bịa đường dẫn hay dữ liệu giả.

Mã thoát, tách bạch thực thi chưa hỗ trợ khỏi đầu vào hỏng:

| Mã | Khi nào |
| --- | --- |
| `0` | Đã lập được kế hoạch dry-run. |
| `1` | Đầu vào không hợp lệ: gói bị từ chối bởi `readPack()` hay bởi kiểm riêng của bộ lập kế hoạch. |
| `2` | Dùng sai cú pháp: thiếu hoặc thừa tham số, tùy chọn lạ. |
| `3` | Chạy thiếu `--dry-run`: thao tác cài thật chưa được triển khai, không gì bị thay đổi. |

### Thứ tự và hình dạng bước

Kế hoạch gồm ba nhóm bước theo thứ tự:

1. **Loại đơn vị** — `PUT /v1/directory/unit-types/{unitType}` với body `{ "name": … }`, theo thứ tự `unitTypes[]` trong manifest (hợp đồng `putDirectoryUnitType` được ghim).
2. **Đơn vị mẫu** — `PUT /v1/directory/units/{unit}` với body `{ "unitType": …, "name": … }` (hợp đồng `putDirectoryUnit`), bố cục cha-trước-con: độ sâu cây tăng dần, bằng độ sâu giữ thứ tự tệp `units.json`. Hợp đồng `DirectoryUnitWrite` được ghim không có trường `parent`, nên kế hoạch sắp thứ tự cha-trước-con nhưng không đặt liên kết cha vào body; khoảng trống này được ghi vào `notes` của kế hoạch.
3. **Nhóm vai trò** — `PUT /v1/directory/units/{unit}/groups/{group}` với body `{ "name": … }` (hợp đồng `putDirectoryGroup`), theo đơn vị mẫu rồi theo thứ tự `groups[]` của manifest.

Quy tắc gán nhóm, xác định từ khai báo quy trình của gói:

- Nhóm `g` được tạo dưới đơn vị `u` khi có một `steps[]` với `role: g` và `u.unitType ∈ steps[].unitTypes`, hoặc `open.role: g` và `u.unitType ∈ open.unitTypes ?? senderUnitTypes` của quy trình đó.
- Nhóm được khai báo nhưng không quy trình nào gán vào loại đơn vị nào sẽ không có bước nào; kế hoạch ghi điều này vào `notes`.

Bước `planned` theo sau, cho mỗi quy trình (đúng thứ tự manifest) một bước `bpmn.definition.load` mang `definitionKey` trùng `workflows[].id` (đã khớp `process/@id`, đọc nguyên văn trong `pack.workflows[].xml`), rồi hai bước `ws_packs.schema.register` và `ws_packs.packRecord.write` mang `packId`, `version` và `definitionKeys`. Thiết kế nâng/gỡ tái dùng các ID này.

### Kiểm riêng của bộ lập kế hoạch

ID đi vào đường dẫn Directory (id của `unitTypes`, `groups` và đơn vị mẫu) phải khớp mẫu tham số đường dẫn được ghim `^[a-z][a-z0-9-]{1,63}$` — schema stableId của gói còn nhận một ký tự, nhưng không tài nguyên Directory nào trỏ được tới ID đó; vi phạm là đầu vào không hợp lệ, mã `PLAN_DIRECTORY_ID_INVALID`, kèm `file`/`path` như lỗi của bộ đọc. Độ dài `name` (1–120) đã do schema gói ghim, khớp các hợp đồng ghi của Directory.

Kiểm thứ hai: id quy trình trở thành khóa định nghĩa BPMN, nên phải khớp mẫu `definitionKey` được ghim của Core `^[a-z][a-z0-9_]{2,63}$` — schema stableId của gói còn nhận gạch ngang và id một hay hai ký tự, nhưng một validateDefinition thật sẽ từ chối các khóa đó, nên bộ lập kế hoạch từ chối trước khi lập: mã `PLAN_DEFINITION_KEY_INVALID`, kèm `file`/`path` như lỗi của bộ đọc. Gói mẫu Health cũ (khóa `chuyen-tuyen`, `thanh-toan`) vì thế bị từ chối ở bước lập kế hoạch cho tới khi gói được đổi khóa.

### Ranh giới với đợt cài thật

Chưa triển khai, và dry-run không được đọc là đã cài: thực thi thật (Directory, nạp BPMN, `ws_packs`), kiểm "phiên bản mới phải lớn hơn" khi nâng, gỡ gói, thử lại sau lỗi từng phần và đổi gói theo cấu hình. Việc nạp BPMN theo tenant chờ [junctura-dxos#112](https://github.com/vku2-open-source-2026/junctura-dxos/issues/112); nghiệm thu cài trên stack thật thuộc issue #27. Kiểm tra tự động của lệnh nằm ở `server/tests/pack-install.test.mjs`.
