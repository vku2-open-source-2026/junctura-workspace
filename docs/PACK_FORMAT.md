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

Cặp gói mẫu của Workspace nằm ở `examples/packs/education/` (Giáo dục) và `examples/packs/health/` (Y tế). Cả hai chỉ chứa dữ liệu tổng hợp, không có người hay đơn vị thật. Gói Y tế thật của Junctura Health vẫn giữ ở kho `junctura-health` theo [PLAN.md](PLAN.md) và phải tuân theo đặc tả này: Workspace ghim đúng bản Health tương ứng trong `.junctura-health-version`, CI checkout cả `pack/` và kiểm gói thật qua `readPack` bằng `scripts/check-health-pack.mjs` — đối chiếu HEAD của checkout với bản ghim và cả mã gói `health` cùng hai khóa định nghĩa thật (`recordTypes`, `workflows`; danh sách nhóm và loại đơn vị của gói không được ghim) và dừng khi bản ghim không phải SHA đầy đủ, HEAD không khớp bản ghim, gói thiếu hoặc sai.

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
| `0` | Đã lập được kế hoạch dry-run, đã cài thật hoặc đã liệt kê bản ghi gói. |
| `1` | Đầu vào không hợp lệ: gói bị từ chối bởi `readPack()` hay bởi kiểm riêng của bộ lập kế hoạch; hoặc lệnh cài thật/liệt kê thất bại (mỗi lỗi kèm `code`, `message` và cờ `uncertain` khi không chắc chắn). |
| `2` | Dùng sai cú pháp: thiếu hoặc thừa tham số, tùy chọn lạ. |
| `3` | Từ chối không tác động: cấu hình lifecycle thiếu (`JUNCTURA_URL`, `JUNCTURA_TENANT`, `JUNCTURA_APP_CLIENT_ID`, `JUNCTURA_APP_CLIENT_SECRET`, `JUNCTURA_OPERATOR_TOKEN` — xem [Cài thật và kiểm tra bản đã cài](#cài-thật-và-kiểm-tra-bản-đã-cài)). |

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

Cài thật đã có (xem [Cài thật và kiểm tra bản đã cài](#cài-thật-và-kiểm-tra-bản-đã-cài)) và dry-run không được đọc là đã cài: nâng/đổi phiên bản là **chọn** một phiên bản đã cài (xem [Chọn phiên bản hoạt động và gỡ an toàn](#chọn-phiên-bản-hoạt-động-và-gỡ-an-toàn-issue-12)), không phải cài lại theo cấu hình. Kiểm tra tự động của lệnh nằm ở `server/tests/pack-install.test.mjs` (dry-run), `server/tests/pack-lifecycle.test.mjs` (cài thật) và `server/tests/pack-selection.test.mjs` (chọn/gỡ, đóng gói mock DX-OS trên loopback).

## Cài thật và kiểm tra bản đã cài (issue #12)

Chạy không `--dry-run` là cài thật; `--list` đọc bản ghi gói đã ghi (cài đầy đủ lẫn chưa xong) mà không thay đổi gì:

```sh
node scripts/pack-install.mjs examples/packs/education
npm run pack:install --prefix server -- ../examples/packs/education
node scripts/pack-install.mjs --list
npm run pack:list --prefix server
```

Cấu hình lifecycle đọc từ môi trường, không bao giờ được in hay ghi log: `JUNCTURA_URL` (origin Gateway), `JUNCTURA_TENANT` (tenant gói cài vào), `JUNCTURA_APP_CLIENT_ID`/`JUNCTURA_APP_CLIENT_SECRET` (app backend đã đăng ký, sở hữu bản ghi `ws_packs`) và `JUNCTURA_OPERATOR_TOKEN` (bearer console-admin tenant trực tiếp cho BPMN publication; token đó phải đồng thời được ghi danh Directory manager có `directory.write` — một ghi danh quản lý của Core gắn với subject, issuer và client đã xác thực, tách riêng vai trò console-admin, xem nguồn Core `infra/postgres/037-directory-management.sql` và `docs/CORE_API.md`). Thiếu cấu hình thì lệnh từ chối với mã thoát 3, không gì bị thay đổi.

### Trình tự cài (`server/pack-lifecycle.mjs`)

Hợp đồng xuất bản là hợp đồng đã kiểm độc lập của Junctura DX-OS PR #113 (merge tại `bb6233f86633a42e1e1e5f58812a53064e6cd9b0`; nghiệm thu phát hành là việc riêng): `POST /v1/workflows/definitions` với body `{"xml": …}` và `Idempotency-Key` là UUID thường, chỉ người console-admin tenant trực tiếp đã xác thực (kèm `core-writer`) mới được đăng, tenant luôn suy từ định danh đã xác thực. 201 mới, 200 replay y hệt, 409 `idempotency_conflict` khi cùng khóa khác nội dung, 409 `deployment_pending_reconciliation` khi yêu cầu khác đang giữ (thử lại cùng khóa), 503 `workflow_unavailable` khi kết quả engine không chắc (cùng khóa replay từ tài nguyên đã triển khai). Ghi Directory là PUT desired-state tại khóa tên (`putDirectoryUnitType`/`putDirectoryUnit`/`putDirectoryGroup`); đọc Directory đi qua hợp đồng danh sách (danh sách đơn vị phân trang, khớp đúng Unit ID — route unit cụ thể chỉ ghim PUT).

Quyền Directory tách riêng console-admin: Core chỉ cho người ghi danh quản lý Directory (gắn với subject, issuer và client đã xác thực) mới được ghi Directory. Lệnh kiểm điều này bằng một preflight hẹp **trước mọi thay đổi**: `GET /v1/directory/unit-types?limit=1` cùng bearer người vận hành, một lượt đọc dùng đúng quyền `directory.write` mà cài sẽ dùng (không dùng lối tắt Console danh sách đơn vị). Thất bại 403 được giữ nguyên trạng thái và báo rõ operator console-admin chưa được ghi danh Directory manager có `directory.write`, với **số tác động bằng không** trên `ws_packs`, Directory và engine; lỗi khác khi đọc preflight được báo là không chắc chắn. Cài thật tiếp tục dùng credential người vận hành đã kiểm cho Directory và BPMN, và credential app backend cho bản ghi thuộc sở hữu app.

Lệnh kiểm gói trước bằng `readPack()` như dry-run — gói hỏng thì không bao giờ được lập kế hoạch, chưa nói tới thực thi — rồi dựng kế hoạch thực thi từ kế hoạch dry-run: các bước Directory giữ nguyên thứ tự, cộng bốn nhóm bước `ready`:

1. `ws_packs.schema.register` — `PUT /v2/data-schemas/ws_packs` (desired-state, replay an toàn), chạy trước mọi đọc/ghi bản ghi.
2. `ws_packs.reservation.create` — upsert bản ghi `ws_packs` theo `key` với trạng thái `installing`, **trước mọi tác động Directory hay Flowable**. Bản ghi giữ chính xác phiên bản và mã băm nội dung (`contentHash` = SHA-256 canonical của manifest + units + BPMN nguồn), nên một phiên bản đã reservate thì nội dung khác cùng phiên bản bị từ chối ngay cả khi chưa có bản ghi hoàn tất nào.
3. Các bước Directory và `POST /v1/workflows/definitions` cho từng quy trình, mỗi quy trình một khóa phái sinh từ `tenant|packId|version|publish|workflowId|contentHash`.
4. `ws_packs.packRecord.finalize` — thay bản ghi theo `key` kèm `If-Match` của ETag vừa đọc, chỉ khi reservation vẫn là bản ghi `installing` của lệnh này; xong mới `available`.

Khóa idempotency phái sinh tất toán từ `tenant|packId|version|op|contentHash` (đồng nhất phiên bản+nội dung): chạy lại sau kết quả không chắc tái dùng **đúng** khóa và body, không bao giờ tự chọn khóa mới. Phản hồi đăng BPMN phải có `id` chuỗi khác rỗng, `key` trùng đúng khóa định nghĩa yêu cầu và `version` nguyên dương trước khi finalize; thiếu gì thì lệnh dừng, reservation còn nguyên và an toàn. Việc Core là thẩm quyền về BPMN nghiệp vụ vẫn giữ: lỗi `definition_invalid` khi đăng được báo kèm `problems`, reservation giữ trạng thái chưa hoàn tất.

Đọc Directory: đơn vị được tra qua `GET /v1/directory/units` phân trang rồi khớp đúng ID; một đơn vị tồn tại với `unitType` khác không bao giờ bị chiếm dụng (mã `DIRECTORY_SCOPE_MISMATCH`). Không ghi đè im lặng lên loại đơn vị, nhóm hay cha không thuộc gói.

### Trạng thái `ws_packs` và phiên bản

Schema `ws_packs` (một bản ghi mỗi phiên bản gói, `uniqueKey: "key"`) chỉ dùng tập con regex an toàn PostgreSQL của Core (không nhóm, không luân phiên, gạch ngang không escape đứng cuối lớp ký tự). Trường `version` **không** khai báo lại giới hạn độ dài hay định dạng semver — schema manifest ghim phiên bản bằng mẫu riêng nên mọi phiên bản hợp lệ theo manifest đều vào được bản ghi, kể tiền phát dài; bản ghi `key` vượt 128 ký tự thì băm SHA-256 thay thế (phép ánh xạ vẫn đơn ánh, phiên bản đầy đủ luôn đi kèm bản ghi và được kiểm lại mỗi lần đọc). Bộ so sánh phiên bản theo luật semver tham chiếu (BigInt, tiền phát trước phát hành) dùng cho kiểm "phiên bản mới phải lớn hơn": một phiên bản thấp hơn phiên bản đã cài bị từ chối (`VERSION_NOT_GREATER`) thay vì lùi trạng thái đã ghi.

Kết quả stdout của cài thật là JSON `{ ok, outcome: "installed" | "replayed", pack, record }`; tiến trình từng bước in trên stderr.

### Kiểm tra bản đã cài (`--list`)

`--list` đọc mọi bản ghi `ws_packs` qua định danh app (phân trang đến hết, có chặn số trang), **không** ghi gì và không đăng ký schema: collection chưa tồn tại (scope chủ còn trống) trả `{ collection: "absent", selection: null, packs: [] }` — một stack mới là danh sách rỗng, không phải lỗi; còn 401/403/5xx hay dữ liệu không đọc được được báo lỗi thay vì bị hiểu nhầm là "chưa cài gì". Mỗi mục gồm `packId`, `version`, `status`, `contentHash`, `complete` (`status === "available"`), `selected` (khớp con trỏ `active`), `definitions` và `directory`, sắp theo packId rồi phiên bản mới nhất trước; `selection` ở cấp kết quả là con trỏ hoạt động (`null` khi chưa chọn). Bản ghi ngoài phạm vi sở hữu app, hoặc phiên bản không xếp được thứ tự, dừng lệnh với mã `RECORD_SCOPE_MISMATCH` thay vì bị bỏ qua. Lựa chọn được đọc bằng **một trang nhỏ không lọc** (xem [Cơ chế giao tác](#cơ-chế-giao-tác)), nên `--list` chạy được trên owner mới chưa đăng ký `ws_pack_selections`.

## Chọn phiên bản hoạt động và gỡ an toàn (issue #12)

Ba lệnh vận hành trạng thái hoạt động của app, dùng đúng cấu hình lifecycle như cài thật:

```sh
node scripts/pack-install.mjs examples/packs/education --select   # chọn phiên bản của thư mục gói đang gắn
npm --prefix server run pack:select -- ../examples/packs/education
node scripts/pack-install.mjs --retire education 0.2.0            # gỡ an toàn một phiên bản đã cài
npm --prefix server run pack:retire -- education 0.2.0
node scripts/pack-install.mjs --list                              # trạng thái cài + lựa chọn hoạt động
```

- `--select <pack-dir>` kiểm gói offline trước (như dry-run), rồi yêu cầu đúng phiên bản đó đã cài và `available`, và **mã băm nội dung của gói đang gắn phải trùng** mã băm đã ghi của phiên bản (`VERSION_CONTENT_MISMATCH` nếu khác) — đây là kiểm tra tối thiểu của gói đang gắn với bản ghi bền vững. Chỉ phiên bản đầy đủ khả dụng mới được chọn; phiên bản thiếu, đang `installing` hay đã `retired` bị từ chối (`SELECTION_TARGET_INVALID`). Chọn lại đúng phiên bản đã chọn là replay không ghi gì (đồng thời kiểm lại gói đang gắn).
- `--retire <pack-id> <version>` chỉ đánh dấu bản ghi phiên bản đó `retired`; phiên bản đang được chọn bị từ chối (`RETIRE_SELECTED` — chọn phiên bản khác trước). Gỡ **không xóa** định nghĩa BPMN đã triển khai, tài nguyên Directory hay bất kỳ bản ghi/tài nguyên cũ nào hồ sơ đang chạy cần; gỡ lại phiên bản đã `retired` là replay. Không có xóa nào trong lệnh.
- Chỉ một phiên bản hoạt động cho mỗi app tại mọi thời điểm.

### Cơ chế giao tác

Trạng thái chọn nằm trong collection do app sở hữu `ws_pack_selections`, đúng một bản ghi khóa `active` với con trỏ rỗng lúc khởi tạo bằng tạo theo key (tạo đua không ghi đè: PUT theo key không If-Match lên bản ghi đã có là 428; collection thiếu vẫn đọc như "chưa có lựa chọn"). Mỗi lệnh đọc lại bản ghi hiện tại cùng ETag mạnh hiện tại, không bao giờ dùng biên nhận tạo cũ — replay cùng khóa trên Core thật có thể trả con trỏ rỗng và ETag gốc dù một lần chọn sau đã commit.

Chọn và gỡ mỗi thao tác là **một** `POST /v2/data:batch` nguyên tử (1–50 thao tác theo thứ tự, rollback toàn bộ khi bất kỳ thao tác hỏng, biên nhận theo `Idempotency-Key` băm toàn bộ yêu cầu gồm mọi điều kiện ghi):

- **Chọn**: thay con trỏ `active` và **thay cùng-dữ-liệu** bản ghi `ws_packs` đích, cả hai theo ETag của lần đọc từng bản ghi hiện tại; đích được kiểm lại đúng id, `packId`, `version`, `contentHash` và `available` ngay dưới chính ETag đó. Một lần gỡ chen giữa danh sách và lần đọc, hoặc giữa lần đọc và commit, không thể bị chọn.
- **Gỡ**: ghim **cùng** ETag con trỏ vừa đọc bằng thay cùng-dữ-liệu, rồi chỉ đánh bản ghi đích `retired` dưới ETag hiện tại của nó. Trước thao tác ghi đầu tiên, schema `ws_packs` hiện tại (có `retired`) được đăng ký lại desired-state: đây là migration giữ bản ghi của Core (kiểm mọi bản ghi cũ và dựng lại chỉ mục trong một giao tác), không xóa dữ liệu cũ; `ws_pack_selections` chỉ đăng ký một lần.

Vì cả hai thao tác mang cùng ETag con trỏ vừa đọc, chọn đua và chọn-vs-gỡ không thể xen nhau: bên thua nhận 412 và **toàn bộ batch rollback**, dừng với lỗi xác định (`SELECTION_PRECONDITION`/`RETIRE_PRECONDITION`). Khóa idempotency phái sinh từ chính cặp ETag đã quan sát: mỗi cặp quan sát dùng đúng một yêu cầu/body qua các lần thử transport (503/423/429/5xx thử lại cùng khóa); chạy lại CLI đọc lại trạng thái đã commit, không làm gì nếu đã đúng ý, còn một lần chọn tay xen vào có thể tạo ý định/điều kiện mới — không bao giờ tự thử lại một giao tác cũ với điều kiện mới trong cùng một lần gọi. Kết quả không chắc chắn dừng với `PENDING_NOT_SETTLED`; con trỏ của bản ghi `active` duy nhất giúp xác nhận giao dịch đã ghi.

### Liên hệ với `JUNCTURA_PACK_DIR` (runtime #13, PR #38)

Bản ghi chọn trong DX-OS là trạng thái gốc; portal Workspace Tầng 2 phục vụ `GET /api/pack` từ gói **đang được gắn** ở `JUNCTURA_PACK_DIR` (mặc định `examples/packs/health`). Để nâng/đổi, người vận hành dùng `pack:select` để kiểm và chọn một thư mục phiên bản (ví dụ `packs/education/0.3.0`), trỏ `JUNCTURA_PACK_DIR` về đúng thư mục đó, rồi tải lại backend; có thể xem lại lựa chọn bằng `pack:list`. Runtime phục vụ đường dẫn đang được gắn, nên con trỏ đã lưu và cấu hình triển khai phải được phối hợp với nhau. PR này không gộp thay đổi frontend hay khởi động của #13.

### Chưa thuộc PR này

- Nâng/đổi gói theo cấu hình Workspace và nghiệm thu trên stack thật (issue #27).
