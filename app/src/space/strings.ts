// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

/** Strings of the public case-type library pages, in plain Vietnamese. */

export const spaceStrings = {
  product: "Cổng Junctura Workspace",
  nav: {
    space: "Không gian loại hồ sơ",
    types: "Loại hồ sơ",
    workflows: "Quy trình",
    units: "Đơn vị",
  },
  packFailed: {
    title: "Không tải được dữ liệu gói ngành",
    lead: "Máy chủ chưa trả lời được về gói đã cài. Hãy tải lại trang để thử lại.",
    retry: "Tải lại trang",
  },
  types: {
    title: "Thư viện loại hồ sơ",
    lead: "Các loại hồ sơ của gói ngành đang được phục vụ: mỗi loại đi kèm quy trình, biểu mẫu, nhóm được phép và hạn xử lý.",
    openDetail: "Xem chi tiết",
  },
  type: {
    packVersion: "Phiên bản gói",
    workflowsTitle: "Quy trình",
    diagram: "Sơ đồ quy trình",
    openForm: "Biểu mẫu mở hồ sơ",
    openRole: "Nhóm mở hồ sơ",
    stepForms: "Biểu mẫu và quyết định của từng bước",
    sla: "Hạn xử lý",
    slaDays: "ngày",
    slaHint: "Số ngày lịch tối đa để hoàn tất bước, tính từ lúc bước mở.",
    groupsTitle: "Nhóm được phép",
    senderGroups: "Nhóm phía đơn vị gửi",
    receiverGroups: "Nhóm phía đơn vị nhận",
    senderUnitTypes: "Loại đơn vị gửi",
    receiverUnitTypes: "Loại đơn vị nhận",
    decisions: "Quyết định",
    requiresReason: "cần lý do",
    fields: { name: "Tên trường", type: "Kiểu dữ liệu", required: "Bắt buộc", optional: "Tuỳ chọn", options: "Lựa chọn" },
    noFields: "Không có trường nào.",
    notFoundTitle: "Không tìm thấy loại hồ sơ",
    notFoundLead: "Gói đang được phục vụ không khai báo loại hồ sơ này. Hãy chọn một loại trong danh sách.",
    backToList: "Về danh sách loại hồ sơ",
  },
  workflows: {
    title: "Quy trình nghiệp vụ dùng chung",
    lead: "Các quy trình BPMN của gói ngành mà các đơn vị chạy chung. Mỗi bước ghi rõ nhóm thực hiện.",
    stepCount: "bước",
    groups: "Nhóm thực hiện",
  },
  units: {
    title: "Các loại đơn vị trong không gian làm việc",
    lead: "Gói ngành khai báo các loại đơn vị: loại nào gửi hồ sơ nào, loại nào nhận và xử lý.",
    opens: "Gửi hồ sơ",
    receives: "Nhận và xử lý",
    none: "Không có",
  },
} as const;
