<!-- SPDX-FileCopyrightText: 2026 Junctura Contributors -->
<!-- SPDX-License-Identifier: Apache-2.0 -->

# Chính sách bảo mật

Cảm ơn bạn đã báo cáo có trách nhiệm. Tài liệu này mô tả phạm vi và cách báo cáo lỗ hổng bảo mật của Junctura Workspace.

## Phạm vi

Áp dụng cho nội dung repo này ở nhánh `main`:

- Giao diện cổng trong `app/`
- Backend cổng trong `server/`
- Cấu hình triển khai: `compose.yaml`, `Dockerfile`, `Caddyfile`

Ngoài phạm vi của repo này — hãy báo cáo qua tab **Security** của repo tương ứng:

- Junctura DX-OS (Tầng 1): [vku2-open-source-2026/junctura-dxos](https://github.com/vku2-open-source-2026/junctura-dxos)
- Junctura Health: [vku2-open-source-2026/junctura-health](https://github.com/vku2-open-source-2026/junctura-health)

Cũng ngoài phạm vi: thử nghiệm từ chối dịch vụ, spam hoặc mọi hành vi gây hại tới hạ tầng demo (ví dụ `health.junctura.studio`). Chỉ kiểm tra trên môi trường tự dựng bằng `compose.yaml` với dữ liệu mẫu.

## Cách báo cáo

1. **Báo cáo riêng tư (ưu tiên).** Mở tab Security của repo: <https://github.com/vku2-open-source-2026/junctura-workspace/security>. Nếu nút **Report a vulnerability** đang hiển thị, dùng nút đó để gửi báo cáo riêng tư qua GitHub.
2. **Phương án dự phòng khi không có báo cáo riêng tư.** Nếu nút trên không có sẵn, hãy mở **issue trống** (không chọn mẫu) tại <https://github.com/vku2-open-source-2026/junctura-workspace/issues/new> và **chỉ mô tả chung chung về ảnh hưởng**: không kèm các bước tái hiện, mã khai thác, cấu hình hay dữ liệu có thể giúp người khác lợi dụng lỗ hổng. Người duy trì sẽ trao đổi trực tiếp để nhận chi tiết.

Issue trống chỉ dành cho dự phòng này; lỗ hổng bảo mật không mô tả chi tiết qua mẫu **Lỗi** hay mẫu **Việc**.

Vui lòng không mở issue công khai kèm chi tiết kỹ thuật của lỗ hổng.

## Nội dung nên có trong báo cáo

- Tệp, đường dẫn hoặc URL bị ảnh hưởng và commit `main` đang dùng.
- Thành phần bị ảnh hưởng (giao diện, backend, cấu hình) và ảnh hưởng chung.
- Đề xuất khắc phục nếu bạn đã có ý tưởng an toàn để chia sẻ.

## Cam kết và hỗ trợ

- Kênh báo cáo ở trên là kênh chính thức duy nhất của repo này; tài liệu không công bố địa chỉ email bảo mật.
- Tài liệu này không cam kết thời gian phản hồi hay điều khoản hỗ trợ cụ thể.
- Bản vá được phát hành cùng mã nguồn qua các bản phát hành thông thường của repo.
