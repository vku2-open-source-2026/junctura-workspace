<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cổng Junctura Workspace (portal)

Ứng dụng giao diện của **Tầng 2**, không gian làm việc chung cho tổ chức nhiều đơn vị. Gồm hai phần:

- **Phần công khai** (`#/`, `#/hop-dong`, `#/quy-trinh`, `#/co-so`): Tầng 2 là gì, **thư viện loại hồ sơ** của gói đang cài (`#/hop-dong`, từng loại có sơ đồ quy trình, biểu mẫu, nhóm được phép và hạn xử lý), quy trình BPMN (`#/quy-trinh`) và các loại đơn vị (`#/co-so`). Nội dung lấy lúc chạy từ `GET /api/pack` — không nhãn gói nào được ghim vào bản build.
- **Không gian làm việc** (cần đăng nhập Junctura, OIDC + PKCE; client `health-portal-web` ở chế độ mặc định, hoặc client ứng dụng đã đăng ký ở `same-client`), theo thứ tự H → P → D:
  - **H · Con người số, Làm việc** (`#/lam-viec`): việc hôm nay của đơn vị, bảng tin của đơn vị điều phối, danh bạ liên thông (`/v1/directory`).
  - **P · Quy trình số, Hồ sơ** (`#/ho-so`): mở hồ sơ theo biểu mẫu mở của gói, hoàn tất bước, trao đổi và tệp đính kèm. Chạy trên API workflow của Tầng 1; hồ sơ không chứa dữ liệu chuyên môn.
  - **D · Dữ liệu số, Điều hành** (`#/dieu-hanh`): số liệu sống: hồ sơ chờ theo đơn vị, thời gian xử lý, trao đổi dữ liệu (nhật ký chuỗi băm của Tầng 1), bản đồ dữ liệu của từng đơn vị (chỉ số đếm, không nội dung), luồng quy trình giữa các loại đơn vị.
  - **I · Trí tuệ số**: làm sau.

  Các trang D, danh bạ và danh sách hồ sơ vẫn cần quyền `audit.read` mà `demo:setup` cấp cho tài khoản nhân viên. Link cũ `#/dieu-phoi` chuyển về `#/lam-viec`.

  Danh tính nhân viên lấy từ DX-OS, không từ dữ liệu mẫu nào: backend gọi `GET /v1/identity` của Tầng 1 bằng **bearer người dùng của chính người gọi** (không dùng `identity()` của SDK — lệnh đó xác thực bằng ứng dụng — và không dùng lệnh liệt kê danh bạ của quản trị viên; không có fallback). Cổng nhận `tenantId`, `units`, `unitPaths` và `groups` đã xác minh; tenant phải khớp `JUNCTURA_TENANT`, `sub` của token đã xác minh phải không rỗng và phải khớp **chính xác** `subject` của phản hồi (lệch là 403, không cấp tư cách hay truy cập nào), và mỗi mục `unitPaths` phải ghép đúng mã đơn vị đã quảng bá với đúng đường dẫn `/{tenant}/{unit}` — phản hồi mâu thuẫn là sai hình dạng (503), không cấp truy cập. Đơn vị cổng là đơn vị đã xác minh của người gọi thuộc tenant đó: nếu tư cách thành viên chứa đúng **một** đơn vị thì đó là đơn vị cổng; người thuộc **nhiều đơn vị** phải chọn rõ qua `?unit=` (chỉ nhận khi tư cách thành viên đã xác minh cho phép), còn thiếu đơn vị, đơn vị lạ hay nhiều đơn vị không chọn đều bị từ chối (403, fail-closed xác định, không phụ thuộc thứ tự). Không có danh sách mã đơn vị ghim sẵn: nhân viên của ngành nào cũng vào được qua tư cách đã xác minh của chính họ; một triển khai muốn giới hạn thì cấu hình tập đơn vị chấp nhận. Phản hồi sai hình dạng hay lõi không truy cập được là 503 `junctura_unavailable`, tách biệt với 401/403. Quyền đăng bảng tin giữ nguyên như trước: cần nhóm đã xác minh `/so-y-te/ban-tin` (chính sách rộng hơn là việc riêng).

  Quyền hành động trên gói được đối chiếu với **đơn vị đã chọn**: `GET /api/me` trả các nhóm đã xác minh, và giao diện chỉ đếm nhóm của đúng đơn vị đó (`/{đơn-vị}/{nhóm}`) khi so với nhóm vai trò trong gói — nhóm của đơn vị khác trong tư cách thành viên không mở được quyền nào. Người dùng cuối không đăng nhập ở đây: họ dùng ứng dụng riêng của Tầng 3. Chuỗi giao diện tiếng Việt nằm trong `app/src/strings.ts` và `app/src/desk/strings.ts`; nhãn của gói (loại hồ sơ, quy trình, nhóm, biểu mẫu) đến từ gói.

## Dữ liệu công khai của gói (`GET /api/pack`)

Đúng một tuyến công khai, chỉ đọc: phép chiếu trắng danh sách của gói đã cài (`server/pack-projection.mjs`) — tên và phiên bản gói, nhóm vai trò, loại đơn vị, loại hồ sơ, biểu mẫu mở, bước xử lý với hạn và quyết định, và **sơ đồ quy trình dạng nút–cạnh** đã dựng sẵn phía máy chủ (không gửi XML thô; chú thích trong BPMN và biểu thức điều kiện nội bộ không bao giờ rời máy chủ, nhãn nhánh lấy từ quyết định của biểu mẫu). Điểm này cố tình công khai vì `pack.json` là cấu hình dùng chung của ngành theo đặc tả gói — chính là nội dung các trang công khai trình bày; nó không chứa dữ liệu người dùng. Được loại ra: `units.json` (dữ liệu cài đặt mẫu), mọi trường ngoài trắng danh sách, và mọi thứ về người gọi. Gói thiếu hoặc hỏng làm backend **từ chối khởi động**; khi trình duyệt không tải được phép chiếu, giao diện hiển thị trạng thái lỗi thấy được với nút tải lại, không bao giờ treo ở trạng thái đang tải hay lặng lẽ dùng nhãn mặc định của một gói khác. Mọi tuyến khác (`/api/me`, bảng tin, ghi chú, tệp) vẫn cần token đã xác minh như cũ.

Landing trước đây liệt kê các ứng dụng Tầng 3 của kế hoạch demo Health; đặc tả gói v1 không khai báo danh sách ứng dụng, nên mục "các loại đơn vị tham gia" giờ liệt kê `unitTypes` của gói — thay đổi này là cố ý, không có danh sách ứng dụng lấy từ repo khác.

## Cấp tư cách thành viên (provisioning)

Mỗi tài khoản nhân viên phải được thêm vào đơn vị của mình qua **API Directory của DX-OS** (`POST /v1/directory/units/{unit}/members` bằng bearer ứng dụng backend), ví dụ `tram-y-te`, `benh-vien` cho gói Y tế hoặc `truong`, `phong-giao-duc` cho gói Giáo dục. Người đăng bảng tin cần đơn vị `so-y-te` **và** nhóm `ban-tin` của đơn vị đó. Khi triển khai thật, thay tài khoản mẫu bằng người dùng thật của tenant và cấp thành viên theo cùng cách; backend không đọc `seed/` lúc chạy.

## Backend (`server/`)

Backend nhỏ của Cổng (`/api`, cùng origin, Node 24 + `node:http` + `@junctura/server-client`, không framework): lưu bản ghi **bảng tin** (`bang-tin`), **ghi chú** và **tệp đính kèm trên hồ sơ liên thông** (`ghi-chu`, `tep-dinh-kem`) vào Tầng 1 như một ứng dụng Junctura thật (client backend `health-portal-backend`; tệp lưu bằng `/v2/objects`, metadata là bản ghi `/v2/data`). Xác thực bằng token người dùng (RS256 qua JWKS, kiểm `iss`/`exp`/`azp`): `health-portal-web` ở chế độ mặc định, hoặc client ứng dụng đã đăng ký khi bật `same-client`; người dùng không phải nhân viên bị từ chối (403), tác giả luôn lấy từ token.

| Biến môi trường | Ý nghĩa |
| --- | --- |
| `PORT`, `HOST` | Lắng nghe, mặc định `127.0.0.1:5190` |
| `JUNCTURA_URL` | Gateway Tầng 1 (HTTPS, hoặc HTTP loopback khi dev) |
| `JUNCTURA_APP_CLIENT_ID`, `JUNCTURA_APP_CLIENT_SECRET` | Client backend của ứng dụng `junctura-health-portal` (do `demo:setup` của Junctura Health cấp); ở chế độ `same-client`, broker dùng chính client này ở phía máy chủ để đổi mã authorization code |
| `OIDC_PORTAL_MODE` | Tuỳ chọn: đặt đúng `same-client` để trình duyệt đổi mã authorization code qua broker cùng origin `POST /api/auth/token`. **Bỏ hẳn biến** để giữ chế độ public client mặc định (gọi endpoint token của issuer qua proxy `/identity`). Mọi giá trị đã đặt khác `same-client`, kể cả chuỗi rỗng, là lỗi cấu hình và backend dừng ngay khi khởi động. |
| `OIDC_PORTAL_ORIGIN` | Bắt buộc khi bật `same-client`: origin chính xác của cổng (ví dụ `https://health.example.org`, không kèm đường dẫn); request tới broker phải có `Origin` khớp chính xác |
| `OIDC_PORTAL_REDIRECT_URI` | Bắt buộc khi bật `same-client`: redirect URI chính xác đã đăng ký với client, khớp URL trình duyệt quay về sau đăng nhập (ví dụ `https://health.example.org/`) |
| `JUNCTURA_TENANT` | Tenant mà danh tính đã xác minh phải thuộc (tệp env do `demo:setup` tạo đã mang sẵn) |
| `JUNCTURA_PACK_DIR` | Thư mục gói đã cài để phục vụ `GET /api/pack`; mặc định `examples/packs/health`, đổi thành `examples/packs/education` (hoặc gói khác theo đặc tả) để trình bày gói khác. Gói hỏng làm backend dừng. |
| `OIDC_ISSUER` | Issuer mà token phải mang trong `iss` (mặc định lấy `JUNCTURA_ISSUER`) |
| `OIDC_KEYS_URL` | Tuỳ chọn: nơi lấy JWKS khi issuer không truy cập được từ trong container |

Chế độ `same-client` là tuỳ chọn bật rõ ràng, không phải mặc định: `OIDC_ISSUER` (hoặc `JUNCTURA_ISSUER`) vẫn là issuer dùng cho đăng nhập/đăng xuất, `JUNCTURA_APP_CLIENT_ID`/`JUNCTURA_APP_CLIENT_SECRET` là client backend đã đăng ký, và `OIDC_PORTAL_REDIRECT_URI` phải trùng khớp URL quay về của cổng. Không có secret nào trong `config.json` hay bundle trình duyệt; trình duyệt chỉ gọi broker cùng origin.

Broker chỉ nhận grant `authorization_code` + PKCE (các grant khác, kể cả `refresh_token`, bị từ chối 400 `unsupported_grant_type`) và chỉ đổi mã; nó không trả `refresh_token` hay `refresh_expires_in` kể cả khi upstream có. DX-OS ổn định cố ý không cấp refresh token cho client ứng dụng đã đăng ký (`use.refresh.tokens=false`) để giữ chính sách grant/assignment đã áp dụng, nên không có cơ chế làm mới ẩn: broker trả access token ngắn hạn kèm thời hạn (`expires_in`) và `id_token` dùng cho đăng xuất. Khi access token hết hạn, yêu cầu API nhận 401, phiên trong bộ nhớ bị xoá và cổng trình bày đăng nhập lại — không tự thử làm mới. Phạm vi này không thêm scope API hay thay đổi API nào.

Tệp công khai `config.json` vẫn giữ `juncturaUrl`, `issuer`, `clientId`. **Thiếu `oidcMode` là hợp lệ** và giữ chế độ public client cũ (bản demo desktop dùng `clientId: "health-portal-web"` và không đặt `oidcMode`). Bật broker bằng cách thêm `"oidcMode": "same-client"`. Ở chế độ này, `clientId` công khai phải trùng **chính xác** `JUNCTURA_APP_CLIENT_ID`, `issuer` phải trùng **chính xác** `OIDC_ISSUER`, và client confidential đã đăng ký phải hỗ trợ luồng authorization-code + PKCE tiêu chuẩn cùng thông tin đăng nhập service account, với redirect URI chính xác; việc cấp refresh token cho client ứng dụng đã đăng ký vẫn theo hành vi đăng ký hiện có của DX-OS (không bật thêm). Một giá trị `oidcMode` sai hình dạng (không phải `undefined` hay `"same-client"`) làm giao diện coi `config.json` là hỏng và rơi về cấu hình mặc định như trước.

Thiết lập cho người vận hành (không đưa credential vào trình duyệt):

1. Trong tệp env hiện có (`.junctura/portal-api.env` khi dev, hoặc tệp do `PORTAL_API_ENV_FILE` chỉ định cho Compose), đặt `OIDC_PORTAL_MODE=same-client`, `OIDC_PORTAL_ORIGIN` và `OIDC_PORTAL_REDIRECT_URI`; giữ `JUNCTURA_APP_CLIENT_ID`/`JUNCTURA_APP_CLIENT_SECRET` và `OIDC_ISSUER` (hoặc `JUNCTURA_ISSUER`) trùng với client/issuer đã đăng ký.
2. Trong `config.json` công khai, đặt `clientId` đúng bằng `JUNCTURA_APP_CLIENT_ID`, `issuer` đúng bằng `OIDC_ISSUER` và thêm `"oidcMode": "same-client"`; bỏ `oidcMode` để giữ public client cũ.
3. Đăng ký redirect URI chính xác đó với client confidential và bảo đảm client hỗ trợ authorization-code + PKCE cùng service account credentials.

## Chạy dev

Từ thư mục gốc Workspace, dùng Node 24 (phiên bản CI nằm trong `.node-version`). Giao diện build được **chỉ từ kho này** (`packages/ui` + `app`): không cần checkout Junctura Health để chạy cổng. Checkout Health ghim (`.junctura-health-version`, hiện là Health PR #47 `53b0a404…`) chỉ còn là đầu vào của CI để kiểm gói Y tế thật qua `scripts/check-health-pack.mjs`.

```sh
npm --prefix packages/ui ci
npm --prefix server ci
npm --prefix app ci
npm --prefix app run dev
```

Giao diện mở tại http://localhost:5180 và nạp phép chiếu gói qua `GET /api/pack` của backend (Vite chuyển tiếp `/api` tới `http://127.0.0.1:5190`), nên trang công khai hiện gói ngay cả khi chưa đăng nhập. Để đăng nhập và dùng các trang gọi API, chạy Junctura DX-OS rồi dùng `npm run demo:setup` trong checkout Junctura Health để đăng ký ứng dụng. Sao chép tệp `.junctura/demo/junctura-health-portal.env` mà lệnh tạo ở repo Health vào `.junctura/portal-api.env` ở Workspace. Chạy backend bằng `node --env-file=.junctura/portal-api.env server/main.mjs`.

Đổi gói đang trình bày bằng cấu hình backend: `JUNCTURA_PACK_DIR=examples/packs/education node --env-file=.junctura/portal-api.env server/main.mjs`. Bản build giao diện giữ nguyên — cùng một bundle hiển thị gói khác ngay sau khi backend đổi cấu hình và tải lại trang.

```sh
npm --prefix server test
npm --prefix app run typecheck
npm --prefix app test
npm --prefix app run build
```

## Docker

Trong tệp `.junctura/portal-api.env`, đặt `JUNCTURA_URL` là địa chỉ HTTPS của DX-OS mà container truy cập được. Backend phục vụ gói mặc định (`examples/packs/health`) đã chép vào ảnh; đặt `JUNCTURA_PACK_DIR` trong tệp env để chọn gói khác. Có thể chỉ định tệp cấu hình khác qua `PORTAL_API_ENV_FILE`. Nếu cần, đặt `JUNCTURA_UPSTREAM` cho Caddy.

```sh
docker compose up -d --build
```

`compose.yaml` mặc định chỉ mở cổng trên `127.0.0.1` (đổi bằng `PORTAL_BIND`), vì bản chạy thật luôn đứng sau một reverse proxy có TLS. `Caddyfile` phục vụ tệp tĩnh của `dist/` và chuyển `/v1/*`, `/identity/*` tới stack Junctura (`JUNCTURA_UPSTREAM`), nên trình duyệt chỉ nói chuyện với một origin và CSP `connect-src 'self'` giữ được; trang quản trị Keycloak (`/identity/admin`) bị chặn. CSP `style-src` cho phép `unsafe-inline` cho các kiểu nội tuyến của React; ngoài ra chỉ còn `self`.

## Triển khai trên subdomain

Ví dụ `health.junctura.studio`, cùng máy với stack Junctura và Caddy hệ thống:

1. DNS: bản ghi `A` cho `health.<domain>` (hoặc wildcard `*.<domain>`) trỏ về máy chủ.
2. Chạy cổng: `docker compose up -d --build`.
3. Thêm site vào Caddy hệ thống, Caddy tự xin chứng chỉ TLS:

   ```caddy
   health.junctura.studio {
     reverse_proxy 127.0.0.1:5180
   }
   ```

   Với stack demo Health: web app của từng cơ sở theo cùng mẫu — `clinic.junctura.studio` tới cổng `5181`, `hospital` `5182`, `myhealth` `5183`, `pharmacy` `5184`, `insurance` `5185`. Origin `https://health.<domain>` của cổng được `demo:setup --domain` thêm vào client `health-portal-web`.
4. Đăng ký origin cho cổng và các ứng dụng bằng `npm --prefix .junctura-health run demo:setup -- --tenant <tenant> --domain junctura.studio` (lệnh demo:setup của Health vẫn dùng cho stack demo Health).
