<!--
SPDX-FileCopyrightText: 2026 Junctura Contributors
SPDX-License-Identifier: Apache-2.0
-->

# @junctura/ui

Gói giao diện React dùng chung của Junctura Workspace, tách từ thư viện UI của Junctura Health ở bản ghi `.junctura-health-version`. Gồm 21 thành phần (`AppShell`, `Layout`, `Button`, `Card`, `DataTable`, `Dialog`, `Fields`, `Tabs`, `Timeline`, `Toast`, `States`, `StatCard`, `Badge`, `Popover`, `CommandSearch`, `DisplayPrefs`, `IdChip`, `PreviewFrame`, `SignInPage`, `LandingPage`, `JuncturaMark`), token màu sáng/tối, stylesheet Tailwind 4 và phông Inter, JetBrains Mono. Giữ nguyên API, hành vi bàn phím/focus, màu và giấy phép Apache-2.0 của nguồn đã ghim.

Khác với nguồn đã ghim, gói không mang giá trị mặc định riêng của một ngành: mô tả đối tượng tìm kiếm theo ngành do app tự cung cấp qua props, chỉ còn mặc định chung trung tính `Tìm kiếm` (xem dưới). Các thành phần chỉ dành cho Y tế (`PatientBanner`, `QueueList`, `Emergency`, `Alerts`, `AiSummaryPanel`) vẫn ở `@junctura/health-ui`.

## Cài đặt

```sh
npm install @junctura/ui react react-dom
```

Cần React 19. Phông Inter và JetBrains Mono là phụ thuộc thường (giấy phép SIL OFL), không nhúng sẵn trong gói.

## Dùng

```tsx
import "@junctura/ui/fonts.css";
import "@junctura/ui/styles.css";
import { DisplayPrefsProvider, ToastProvider, AppShell } from "@junctura/ui";
```

- `styles.css`: stylesheet đủ dùng (token + các lớp Tailwind mà thành phần cần).
- App có Tailwind 4 riêng: nhập `@junctura/ui/tokens.css` rồi thêm thư viện vào `@source` để dùng chung token và viết bố cục riêng:

```css
@import "tailwindcss";
@import "@junctura/ui/tokens.css";
@source "../node_modules/@junctura/ui/dist/index.js";
```

Bọc ứng dụng trong `DisplayPrefsProvider` (cỡ chữ 16 / 17,5 / 19 px, chế độ sáng/tối, nhớ trong trình duyệt) và `ToastProvider` (thông báo có vùng `aria-live`).

## Cho `@junctura/health-ui`

Gói giữ nguyên API của nguồn đã ghim, kể cả `placeholder` tuỳ chọn của tìm nhanh: không truyền gì thì dùng chung `Tìm kiếm`. `@junctura/health-ui` dựng trên gói này bằng một wrapper mỏng và truyền lại đúng chữ cũ của Health:

| Thành phần | Prop | Giá trị Health tự cung cấp |
| --- | --- | --- |
| `CommandSearch` | `placeholder` (tuỳ chọn, mặc định chung `Tìm kiếm`) | `"Tìm theo họ tên, số điện thoại, mã hồ sơ"` |
| `AppShell` (`search`) | `placeholder` (tuỳ chọn, mặc định chung `Tìm kiếm`) | `"Tìm người bệnh, mã hồ sơ"` — tên nút tìm nhanh và cũng là placeholder của hộp thoại tìm |

Ngoài ra wrapper giữ lại các thành phần và helper riêng của Health: `PatientBanner`, `QueueList`, `EmergencyDialog`, `AlertBanner`, `AiSummaryPanel`, `ActionList` cùng `ageFromBirthYear` và `sexLabel` nếu cần dùng tiếp.

## Phát triển

```sh
npm ci
npm run typecheck
npm test
npm run build
npm pack
```
