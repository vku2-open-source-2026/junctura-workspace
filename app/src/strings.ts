// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Every string shown by the portal that does not come from the installed pack,
 * in plain Vietnamese. The pack supplies its own labels, record types, forms,
 * groups and workflows at runtime; these strings describe the workspace itself
 * and stay identical no matter which pack is served.
 */

export const strings = {
  app: {
    name: "Cổng Junctura Workspace",
    shortName: "Junctura Workspace",
    tagline: "Không gian làm việc liên thông",
    lead:
      "Junctura Workspace là Tầng 2 của Junctura DX-OS: nơi đặt luật chơi chung để các đơn vị trao đổi hồ sơ với nhau theo quy trình và biểu mẫu của gói ngành đã cài, và nơi cơ quan điều phối theo dõi mọi hồ sơ đi qua nhiều đơn vị.",
    note: "Dữ liệu trong bản demo là dữ liệu giả lập, không có thông tin người thật.",
    signIn: "Vào không gian làm việc",
  },
  signIn: {
    title: "Không gian làm việc liên thông",
    subtitle: "Dành cho nhân viên các đơn vị tham gia. Đăng nhập bằng tài khoản Junctura của bạn.",
    note: "Ứng dụng cuối người dùng không làm việc ở đây: người dùng cuối quản lý dữ liệu của mình trong ứng dụng riêng của Tầng 3.",
    notStaff: "Tài khoản này không thuộc đơn vị nào trong không gian làm việc, nên không mở được mục làm việc.",
    signOut: "Đăng xuất",
    failed: "Không mở được trang đăng nhập. Hãy thử lại.",
    badRedirect: "Đăng nhập chưa hoàn tất. Hãy đăng nhập lại.",
    sessionEnded: "Phiên đăng nhập đã hết. Hãy đăng nhập lại.",
  },
  landing: {
    layersTitle: "Junctura Workspace nằm ở đâu",
    layersLead: "Junctura chia làm ba tầng. Cổng này là giao diện của Tầng 2.",
    layers: [
      { title: "Tầng 1 · Junctura DX-OS", text: "Lõi trung lập: định danh, đồng thuận, vé gọi dùng một lần, kho dữ liệu, công cụ quy trình và nhật ký. Lõi không biết gì về một ngành cụ thể." },
      { title: "Tầng 2 · Junctura Workspace", text: "Không gian làm việc chung cho tổ chức nhiều đơn vị: loại hồ sơ, biểu mẫu, quy trình và cổng chung đến từ gói ngành đã cài, nơi các đơn vị cùng xử lý hồ sơ và cơ quan điều phối điều hành." },
      { title: "Tầng 3 · Ứng dụng của đơn vị", text: "Phần mềm riêng của từng đơn vị và ứng dụng của người dùng cuối. Mỗi ứng dụng giữ dữ liệu của mình và gọi thẳng Tầng 1." },
    ],
    benefitsTitle: "Cổng Junctura Workspace có gì",
    benefitsLead: "Một nơi làm việc chung cho các đơn vị của tổ chức, chạy trên Junctura DX-OS.",
    benefits: [
      { title: "Làm việc chung", text: "Mỗi đơn vị thấy việc của mình hôm nay, đọc bảng tin chung và tra danh bạ liên thông." },
      { title: "Hồ sơ liên thông", text: "Các loại hồ sơ của gói ngành là hồ sơ số đi qua từng đơn vị theo quy trình chung, có trao đổi và tệp đính kèm." },
      { title: "Điều hành bằng số liệu", text: "Cơ quan điều phối xem số liệu sống: hồ sơ đang chờ ở đâu, xử lý mất bao lâu, dữ liệu nằm ở đâu và chia sẻ cho ai." },
      { title: "Trợ lý AI (sắp có)", text: "Tóm tắt và gợi ý trên dữ liệu của không gian, luôn ghi rõ cần người kiểm tra lại." },
    ],
    howTitle: "Một hồ sơ đi qua các đơn vị như thế nào",
    how: [
      { title: "Đơn vị gửi mở hồ sơ", text: "Nhân viên mở hồ sơ trong mục Hồ sơ liên thông, điền biểu mẫu mở do gói ngành quy định. Hồ sơ chỉ mang mã tham chiếu và dữ liệu điều phối." },
      { title: "Đơn vị nhận xử lý", text: "Nhóm phụ trách ở đơn vị nhận thấy hồ sơ đang chờ mình, điền biểu mẫu của bước và chọn một quyết định kèm lý do khi cần." },
      { title: "Cơ quan điều phối theo dõi", text: "Ở mục Điều hành, cơ quan điều phối thấy hồ sơ đang ở bước nào, đơn vị nào đang giữ, mất bao lâu. Tầng 1 ghi nhật ký mọi lần truy cập dữ liệu." },
    ],
    catalogTitle: "Loại hồ sơ dùng chung",
    catalogLead: "Danh mục lấy từ gói ngành đang được phục vụ. Các đơn vị mở và xử lý hồ sơ đúng theo loại và quy trình của gói.",
    packFailedTitle: "Không tải được dữ liệu gói ngành",
    packFailed: "Máy chủ chưa trả lời được về gói đã cài. Hãy tải lại trang để thử lại.",
    facilityTitle: "Các loại đơn vị tham gia",
    facilityLead: "Gói ngành khai báo các loại đơn vị của tổ chức: đơn vị gửi hồ sơ, đơn vị nhận và xử lý, đơn vị điều phối.",
    faqTitle: "Câu hỏi thường gặp",
    faq: [
      { q: "Ai dùng cổng này?", a: "Phần công khai dành cho bất kỳ ai muốn biết luật chơi chung. Phần làm việc dành cho nhân viên các đơn vị tham gia, đăng nhập bằng tài khoản Junctura." },
      { q: "Người dùng cuối có đăng nhập ở đây không?", a: "Không. Người dùng cuối dùng ứng dụng riêng của Tầng 3 để quản lý dữ liệu và quyền của mình." },
      { q: "Tầng 2 có giữ dữ liệu chuyên môn không?", a: "Không. Dữ liệu chuyên môn nằm trong ứng dụng của từng đơn vị. Hồ sơ liên thông chỉ mang mã tham chiếu, thông tin điều phối và trạng thái các bước." },
      { q: "Loại hồ sơ và quy trình đến từ đâu?", a: "Từ gói ngành đã cài: gói khai báo loại hồ sơ, biểu mẫu, nhóm xử lý, hạn xử lý và quy trình BPMN. Cổng trình bày đúng nội dung gói đang được phục vụ." },
    ],
  },
  catalog: {
    workflowCount: "quy trình",
    openDetail: "Xem chi tiết",
  },
} as const;
