<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Cổng Junctura Health (portal)

Ứng dụng giao diện của **Tầng 2**, không gian y tế liên thông do Sở Y tế điều phối. Gồm hai phần:

- **Phần công khai** (`#/`, `#/hop-dong`, `#/quy-trinh`, `#/co-so`): Tầng 2 là gì, hợp đồng dữ liệu, quy trình liên thông và các cơ sở tham gia. Dữ liệu lấy lúc build từ `contracts/`, `workflows/` và `demo/plan.mjs` của Junctura Health, không gọi API.
- **Không gian làm việc** (cần đăng nhập Junctura, OIDC + PKCE, client `health-portal-web`), theo thứ tự H → P → D của đề OLP:
  - **H · Con người số, Làm việc** (`#/lam-viec`): việc hôm nay của cơ sở, bảng tin của Sở Y tế, danh bạ liên thông (`/v1/directory`).
  - **P · Quy trình số, Hồ sơ** (`#/ho-so`): mở hồ sơ liên thông (chuyển tuyến, xác minh đơn thuốc, xác minh chi phí) kèm biểu mẫu điều phối (mức khẩn, cơ sở nhận, ghi chú), hoàn tất bước của cơ sở mình, trao đổi và tệp đính kèm. Chạy trên API workflow của Tầng 1; hồ sơ không chứa bệnh án.
  - **D · Dữ liệu số, Điều hành** (`#/dieu-hanh`): số liệu sống cho Sở Y tế: hồ sơ chờ theo cơ sở, thời gian xử lý, trao đổi dữ liệu (nhật ký chuỗi băm của Tầng 1), bản đồ dữ liệu của từng cơ sở (chỉ số đếm, không nội dung), chia sẻ dữ liệu và năng lực theo hợp đồng.
  - **I · Trí tuệ số**: làm sau.

  Cơ sở của tài khoản lấy từ dữ liệu mẫu `seed/data/accounts.json` của Junctura Health; các trang D, danh bạ và danh sách hồ sơ cần quyền `audit.read` mà `demo:setup` cấp cho tài khoản nhân viên. Link cũ `#/dieu-phoi` chuyển về `#/lam-viec`.

Người bệnh không đăng nhập ở đây: họ quản lý đồng thuận trong ứng dụng **Sổ sức khỏe (MyHealth)** của Tầng 3. Chuỗi giao diện tiếng Việt nằm trong `app/src/strings.ts` và `app/src/desk/strings.ts`.

## Backend (`server/`)

Backend nhỏ của Cổng (`/api`, cùng origin, Node 24 + `node:http` + `@junctura/server-client`, không framework): lưu bản ghi **bảng tin** (`bang-tin`), **ghi chú** và **tệp đính kèm trên hồ sơ liên thông** (`ghi-chu`, `tep-dinh-kem`) vào Tầng 1 như một ứng dụng Junctura thật (client backend `health-portal-backend`; tệp lưu bằng `/v2/objects`, metadata là bản ghi `/v2/data`). Xác thực bằng token người dùng của client web `health-portal-web` (RS256 qua JWKS, kiểm `iss`/`exp`/`azp`); người bệnh bị từ chối (403), tác giả luôn lấy từ token.

| Biến môi trường | Ý nghĩa |
| --- | --- |
| `PORT`, `HOST` | Lắng nghe, mặc định `127.0.0.1:5190` |
| `JUNCTURA_URL` | Gateway Tầng 1 (HTTPS, hoặc HTTP loopback khi dev) |
| `JUNCTURA_APP_CLIENT_ID`, `JUNCTURA_APP_CLIENT_SECRET` | Client backend của ứng dụng `junctura-health-portal` (do `demo:setup` của Junctura Health cấp) |
| `OIDC_ISSUER` | Issuer mà token phải mang trong `iss` (mặc định lấy `JUNCTURA_ISSUER`) |
| `OIDC_KEYS_URL` | Tuỳ chọn: nơi lấy JWKS khi issuer không truy cập được từ trong container |

## Chạy dev

Từ thư mục gốc Workspace, dùng Node 24 (phiên bản CI nằm trong `.node-version`) và lấy đúng phiên bản Junctura Health dùng để build giao diện và đọc dữ liệu mẫu.

```sh
git clone --filter=blob:none --no-checkout https://github.com/vku2-open-source-2026/junctura-health.git .junctura-health
git -C .junctura-health checkout --detach "$(cat .junctura-health-version)"
npm --prefix server ci
npm --prefix .junctura-health/ui ci
npm --prefix app ci
npm --prefix app run dev
```

Giao diện mở tại http://localhost:5180. Để đăng nhập và dùng các trang gọi API, chạy Junctura DX-OS rồi dùng `npm run demo:setup` trong checkout Junctura Health để đăng ký ứng dụng. Sao chép tệp `.junctura/demo/junctura-health-portal.env` mà lệnh tạo ở repo Health vào `.junctura/portal-api.env` ở Workspace. Chạy backend bằng `node --env-file=.junctura/portal-api.env server/main.mjs`. Vite chuyển tiếp `/api` tới `http://127.0.0.1:5190`.

```sh
npm --prefix server test
npm --prefix app run typecheck
npm --prefix app test
npm --prefix app run build
```

## Docker

Dùng cùng checkout Junctura Health đã lấy ở trên. Trong tệp `.junctura/portal-api.env`, đặt `JUNCTURA_URL` là địa chỉ HTTPS của DX-OS mà container truy cập được. Có thể chỉ định tệp cấu hình khác qua `PORTAL_API_ENV_FILE`. Nếu cần, đặt `JUNCTURA_UPSTREAM` cho Caddy.

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

   Web app của từng cơ sở theo cùng mẫu: `clinic.junctura.studio` tới cổng `5181`, `hospital` `5182`, `myhealth` `5183`, `pharmacy` `5184`, `insurance` `5185`. Origin `https://health.<domain>` của cổng được `demo:setup --domain` thêm vào client `health-portal-web`.
4. Đăng ký origin cho cổng và năm ứng dụng từ checkout Junctura Health bằng `npm --prefix .junctura-health run demo:setup -- --tenant <tenant> --domain junctura.studio`.
