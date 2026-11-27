/** Bilingual (VI / EN) editorial copy for TINA's pre-login landing & interactive Hero scene.
 *  Default locale is Vietnamese (`vi`); users can switch live between VI and EN in the header. */

export type LandingLang = "vi" | "en";

export type SceneBeatId = "minh" | "linh" | "tina-reply" | "lan";

export interface SceneBeatCopy {
  speaker: string;
  badge: string;
  text: string;
  sub: string;
  isAgent: boolean;
  botSeated: boolean;
  activeHumanBubble: 1 | 2 | 3 | null;
  posClass: "posMinh" | "posLinh" | "posJky" | "posBotSeated" | "posBotRight";
}

export interface LandingCopy {
  nav: {
    live: string;
    extension: string;
    how: string;
    useCases: string;
    privacy: string;
    faq: string;
    signIn: string;
    claimAdmin: string;
    toggleNav: string;
  };
  hero: {
    claimBadge: string;
    claimHeading: string;
    claimLead: string;
    titleLine1: string;
    titleSerif: string;
    titleMid: string;
    titleLine3Prefix: string;
    titleAccent: string;
    lead: string;
    googleCta: string;
    microsoftCta: string;
    secondaryCta: string;
    claimFoot: string;
    devNoticePrefix: string;
    devNoticeSuffix: string;
    noOAuthClaimNotice: string;
    noOAuthNotice: string;
    debugShow: string;
    debugHide: string;
    directHintClaim: string;
    directHintDebug: string;
    directSubmit: string;
    directSubmitAdmin: string;
    directSubmitting: string;
  };
  scene: {
    ariaLabel: string;
    imgAlt: string;
    callTina: string;
    joinTable: string;
    leaveTable: string;
    autoplayOn: string;
    autoplayPaused: string;
    demo: string;
    hotspots: {
      minh: string;
      seatedBot: string;
      linh: string;
      lan: string;
      rollingBotIn: string;
      rollingBotOut: string;
    };
    beats: Record<SceneBeatId, SceneBeatCopy>;
  };
  ticker: {
    label: string;
    pause: string;
    resume: string;
    items: string[];
  };
  live: {
    label: string;
    titleLead: string;
    titleSerif: string;
    sub: string;
    shellTitle: string;
    columns: { speaker: string; original: string; translation: string };
    pause: string;
    resume: string;
    voiceReply: string;
    lines: Array<{
      speaker: string;
      role?: string;
      originalLang?: LandingLang;
      time: string;
      primary: string;
      secondary: string;
      isAgent: boolean;
    }>;
    bullets: string[];
  };
  extension: {
    label: string;
    titleLead: string;
    titleSerif: string;
    sub: string;
    points: Array<{ tag: string; title: string; body: string }>;
    tabs: {
      bilingual: string;
      catchup: string;
      ask: string;
    };
    bilingualRows: Array<{ speaker: string; time: string; vi: string; en: string }>;
    catchupWindow: string;
    catchupSummary: string;
    catchupBullets: string[];
    askQuestion: string;
    askAnswer: string;
    askCitation: string;
    askWikiBtn: string;
    askWikiSaved: string;
  };
  how: {
    label: string;
    titleLine1: string;
    titleSerif: string;
    titleLine2Rest: string;
    sub: string;
    steps: [
      { kicker: string; title: string; body: string },
      { kicker: string; title: string; body: string },
      { kicker: string; title: string; body: string; wakePrompt: string },
    ];
    copy: string;
    copied: string;
    proofPrefix: string;
    proofHighlight1: string;
    proofMid: string;
    proofHighlight2: string;
    proofCta: string;
  };
  useCases: {
    label: string;
    titleLead: string;
    titleSerif: string;
    titleTail: string;
    sub: string;
    surfaces: Array<{ tag: string; title: string; body: string; bestFor: string }>;
    casesHeading: string;
    cases: Array<{ num: string; title: string; body: string }>;
  };
  privacy: {
    label: string;
    titleLead: string;
    titleSerif: string;
    sub: string;
    cards: Array<{ tag: string; title: string; body: string }>;
    platformsLabel: string;
    platformsTitleLead: string;
    platformsTitleSerif: string;
    platformsTitleTail: string;
    platformsSub: string;
    leftColTitle: string;
    leftColItems: string[];
    rightColTitle: string;
    rightColItems: string[];
  };
  faq: {
    label: string;
    items: Array<{ q: string; a: string }>;
  };
  cta: {
    titleLine1: string;
    titleSerif: string;
    sub: string;
    primary: string;
    primaryClaim: string;
    backToTop: string;
  };
  footer: {
    tagline: string;
    col1: string;
    col2: string;
    col3: string;
    col3SignIn: string;
    col3Claim: string;
    col3AuthOptions: string;
    copyright: string;
    motto: string;
  };
}

export const LANDING_COPY: Record<LandingLang, LandingCopy> = {
  vi: {
    nav: {
      live: "Trực tiếp",
      extension: "Extension",
      how: "Cách dùng",
      useCases: "Ứng dụng",
      privacy: "Bảo mật",
      faq: "FAQ",
      signIn: "Đăng nhập",
      claimAdmin: "Khởi tạo Admin",
      toggleNav: "Mở menu điều hướng",
    },
    hero: {
      claimBadge: "Lần đăng nhập đầu tiên = Quản trị viên",
      claimHeading: "Thiết lập không gian TINA",
      claimLead:
        "Hệ thống TINA này chưa có quản trị viên. Tài khoản đăng nhập đầu tiên sẽ trở thành Admin để cấu hình mô hình AI, nhận dạng giọng nói và mời thành viên.",
      titleLine1: "Đồng đội AI",
      titleSerif: "biết nghe, dịch",
      titleMid: " và",
      titleLine3Prefix: "trả lời ",
      titleAccent: "ngay trong họp.",
      lead: "Xem transcript Việt – Anh trên Google Meet, Zoom và Teams. Gọi “Tina ơi” để hỏi bằng giọng nói khi trợ lý được bật.",
      googleCta: "Tiếp tục với Google",
      microsoftCta: "Tiếp tục với Microsoft",
      secondaryCta: "Xem TINA hoạt động",
      claimFoot: "Màn hình khởi tạo này sẽ tự ẩn sau khi đã có quản trị viên.",
      devNoticePrefix: "Chế độ kiểm thử nội bộ — chỉ hỗ trợ email @example.test. Thêm ",
      devNoticeSuffix: " để bật đăng nhập OAuth.",
      noOAuthClaimNotice: "Hãy cấu hình Google hoặc Microsoft OAuth để đăng nhập. Đăng nhập thử không mật khẩu bị tắt ngoài môi trường dev.",
      noOAuthNotice: "Hệ thống chưa cấu hình nhà cung cấp OAuth. Hãy bật Google hoặc Microsoft OAuth trên máy chủ.",
      debugShow: "Đăng nhập thử (@example.test)",
      debugHide: "Ẩn đăng nhập thử",
      directHintClaim: "Email — sử dụng địa chỉ @example.test (chỉ dành cho môi trường dev).",
      directHintDebug: "Đăng nhập kiểm thử — sử dụng địa chỉ @example.test.",
      directSubmit: "Đăng nhập",
      directSubmitAdmin: "Đăng nhập quyền Admin",
      directSubmitting: "Đang đăng nhập…",
    },
    scene: {
      ariaLabel: "Minh họa tương tác cảnh họp cùng TINA",
      imgAlt: "Minh họa nét vẽ tay trợ lý AI lăn ghế tham gia bàn họp cùng đội ngũ",
      callTina: "Gọi “Tina ơi”",
      joinTable: "Vào bàn họp",
      leaveTable: "Rời bàn",
      autoplayOn: "Tự động",
      autoplayPaused: "Tạm dừng",
      demo: "Hội thoại minh họa",
      hotspots: {
        minh: "Nghe Minh đặt câu hỏi",
        seatedBot: "Xem TINA Agent tổng hợp",
        linh: "Linh gọi Tina ơi",
        lan: "Lan chốt lưu Wiki song ngữ",
        rollingBotIn: "Cho TINA lăn ghế vào bàn họp",
        rollingBotOut: "Cho TINA rời khỏi bàn họp",
      },
      beats: {
        minh: {
          speaker: "Minh · Product",
          badge: "09:40 · VI",
          text: "Khách hàng Enterprise muốn chốt lịch triển khai Q4 trước thứ 6.",
          sub: "Enterprise client wants Q4 rollout confirmed by Friday.",
          isAgent: false,
          botSeated: false,
          activeHumanBubble: 1,
          posClass: "posMinh",
        },
        linh: {
          speaker: "Linh · Ops",
          badge: "GỌI GIỌNG NÓI",
          text: "“Tina ơi, ta đã chốt gì tuần trước?!”",
          sub: "Đang đánh thức TINA Voice Agent…",
          isAgent: false,
          botSeated: true,
          activeHumanBubble: 2,
          posClass: "posLinh",
        },
        "tina-reply": {
          speaker: "TINA Agent",
          badge: "ĐÃ ĐỌC · VOICE TTS",
          text: "Tuần trước nhóm chốt 2 mục: gửi bản đánh giá bảo mật thứ 4 và chạy thử song ngữ cho 20 nhân sự.",
          sub: "Nguồn (2) · Trích dẫn trực tiếp cuộc họp 18/11",
          isAgent: true,
          botSeated: true,
          activeHumanBubble: null,
          posClass: "posBotSeated",
        },
        lan: {
          speaker: "Lan · Lead",
          badge: "09:41 · VI + EN",
          text: "Chuẩn luôn — lưu thẳng bản song ngữ vào Wiki khách hàng nhé!",
          sub: "Đã đồng bộ vào Wiki nhóm ✓",
          isAgent: false,
          botSeated: true,
          activeHumanBubble: 3,
          posClass: "posJky",
        },
      },
    },
    ticker: {
      label: "Điểm nổi bật của TINA",
      pause: "Tạm dừng thanh chữ chạy",
      resume: "Tiếp tục thanh chữ chạy",
      items: [
        "GOOGLE MEET",
        "ZOOM",
        "MICROSOFT TEAMS",
        "DỊCH SONG NGỮ VI + EN",
        "TRỢ LÝ GIỌNG NÓI “TINA ƠI”",
        "CHROME EXTENSION",
        "BẮT KỊP 60 GIÂY",
        "BẢO MẬT DOANH NGHIỆP",
      ],
    },
    live: {
      label: "Trong cuộc họp",
      titleLead: "Nghe rõ ai nói gì — ",
      titleSerif: "và hỏi TINA thành tiếng.",
      sub: "Lời thoại tiếng Việt và bản dịch tiếng Anh hiển thị theo thời gian thực cùng tên người nói, xen kẽ trực tiếp câu trả lời giọng nói của TINA Agent và nút xem nguồn trích dẫn.",
      shellTitle: "Transcript Việt – Anh",
      columns: { speaker: "Người nói", original: "Nguyên văn", translation: "Bản dịch" },
      pause: "Tạm dừng hội thoại mẫu",
      resume: "Tiếp tục hội thoại mẫu",
      voiceReply: "Trả lời bằng giọng nói",
      lines: [
        {
          speaker: "Minh Nguyễn",
          role: "Product Lead",
          originalLang: "vi",
          time: "09:40:12",
          primary: "Mình cần chốt lại tiến độ bản phát hành Q4 và phần đánh giá bảo mật cho đối tác Singapore trước thứ 6.",
          secondary: "We need to lock the Q4 release timeline and security review for our Singapore partner by Friday.",
          isAgent: false,
        },
        {
          speaker: "Linh Hoàng",
          role: "Operations",
          originalLang: "vi",
          time: "09:40:38",
          primary: "Tina ơi, nhắc lại 2 cam kết tuần trước mình đã thống nhất với đối tác giúp cả nhóm nhé.",
          secondary: "Tina, remind the team of the two commitments we agreed on with the partner last week.",
          isAgent: false,
        },
        {
          speaker: "TINA Agent",
          time: "09:40:44",
          primary:
            "Tuần trước nhóm đã chốt 2 cam kết: hoàn tất đánh giá bảo mật vào thứ 4 và triển khai chạy thử song ngữ cho 20 nhân sự vận hành trong tuần tới.",
          secondary: "Nguồn (2): Đoạn 09:40:12 và biên bản 18/11",
          isAgent: true,
        },
        {
          speaker: "Daniel Lee",
          role: "Partner",
          originalLang: "en",
          time: "09:41:02",
          primary: "Exact match — please save this summary and action list straight to our shared workspace.",
          secondary: "Chính xác — nhờ lưu bản tóm tắt và danh sách đầu việc này thẳng vào không gian làm việc chung nhé.",
          isAgent: false,
        },
      ],
      bullets: [
        "Talk Time: thời lượng, tốc độ và tỉ lệ phát biểu theo người nói",
        "Bản dịch Việt – Anh theo cụm câu",
        "Trả lời bằng giọng nói kèm nguồn khi có",
        "Trong cuộc họp đã ghi, chọn dòng thoại để nghe lại từ mốc đó",
      ],
    },
    extension: {
      label: "TINA Chrome Extension",
      titleLead: "Hiện diện ngay trong Google Meet — ",
      titleSerif: "không cần chuyển tab.",
      sub: "TINA Chrome Extension gắn một khung điều khiển nhỏ gọn ngay trên màn hình Google Meet giúp bạn theo dõi phụ đề song ngữ, bắt kịp mạch họp chỉ bằng một cú bấm và hỏi TINA ngay tại chỗ.",
      points: [
        {
          tag: "SONG NGỮ",
          title: "Phụ đề Việt – Anh ngay cạnh khung video",
          body: "Tự động gom câu nói hoàn chỉnh của từng người tham gia, hiển thị bản gốc và bản dịch tiếng Anh tách lớp rõ ràng.",
        },
        {
          tag: "60 GIÂY",
          title: "Bắt kịp 60 giây tức thì",
          body: "Vừa quay lại cuộc họp hoặc lỡ mất đoạn thảo luận? Bấm một nút để nhận tóm tắt 60 giây gần nhất kèm mốc thời gian xác thực.",
        },
        {
          tag: "ASK TINA",
          title: "Hỏi trực tiếp & Lưu vào Wiki trong 1 chạm",
          body: "Đặt câu hỏi dựa trên nội dung đã xác nhận và tài liệu liên kết, kiểm tra câu trích dẫn gốc rồi lưu thẳng thành trang Wiki nhóm.",
        },
        {
          tag: "AN TOÀN",
          title: "Không ghi âm từ trình duyệt",
          body: "Extension không xin quyền microphone hay thu âm tab — chỉ hiển thị dữ liệu đã phân quyền từ TINA Bot.",
        },
      ],
      tabs: {
        bilingual: "Song ngữ",
        catchup: "Bắt kịp",
        ask: "Ask TINA",
      },
      bilingualRows: [
        {
          speaker: "Minh Nguyễn",
          time: "09:40",
          vi: "Bản Q4 ưu tiên mở khóa trải nghiệm họp song ngữ cho khối đối tác.",
          en: "Q4 prioritizes unlocking the bilingual meeting workflow for partner teams.",
        },
        {
          speaker: "Daniel Lee",
          time: "09:41",
          vi: "Nếu có báo cáo bảo mật vào thứ 4 thì chúng tôi sẵn sàng kích hoạt ngay.",
          en: "If the security report lands Wednesday, we are ready to launch immediately.",
        },
      ],
      catchupWindow: "Cửa sổ 09:40:02 – 09:41:02 · Transcript đã xác nhận",
      catchupSummary: "Nhóm đang chốt điều kiện kích hoạt gói Enterprise Q4 với đối tác Singapore:",
      catchupBullets: [
        "Thứ 4: Linh gửi bộ đánh giá bảo mật & phân quyền dữ liệu.",
        "Tuần tới: Mở chạy thử song ngữ cho 20 nhân sự vận hành.",
        "Trạng thái: Đối tác đồng thuận mốc thứ 6 nếu đủ hồ sơ bảo mật.",
      ],
      askQuestion: "Đối tác yêu cầu điều kiện gì để kích hoạt vào thứ 6?",
      askAnswer: "Đối tác cần nhận bản đánh giá bảo mật vào thứ 4 và danh sách 20 tài khoản chạy thử nghiệm song ngữ.",
      askCitation: "Nguồn (2) · 09:40:12 (Minh Nguyễn) · 09:41:02 (Daniel Lee)",
      askWikiBtn: "Lưu vào Wiki",
      askWikiSaved: "Đã mô phỏng lưu vào Wiki",
    },
    how: {
      label: "Thiết lập",
      titleLine1: "Một chạm đăng nhập Google.",
      titleSerif: "TINA",
      titleLine2Rest: " sẵn sàng vào họp.",
      sub: "Đăng nhập, kiểm tra mô hình được bật rồi gửi TINA vào một cuộc họp được hỗ trợ.",
      steps: [
        {
          kicker: "ĐĂNG NHẬP",
          title: "Kết nối không gian làm việc.",
          body: "Đăng nhập bằng Google để mở sổ cuộc họp cá nhân hoặc nhóm. Liên kết Google / Outlook Calendar để lịch họp tự đồng bộ.",
        },
        {
          kicker: "CHỌN AI",
          title: "Tự chọn mô hình AI & giọng nói.",
          body: "Xem các mô hình và dịch vụ giọng nói đã được bật trong Cài đặt.",
        },
        {
          kicker: "VÀO HỌP",
          title: "Gửi TINA & tương tác bằng giọng nói.",
          body: "Dán link Google Meet, Zoom, Teams hoặc bấm Gửi Bot từ Chrome Extension. Gọi trực tiếp khi cần tổng hợp:",
          wakePrompt: "Tina ơi, ta đã chốt gì tuần trước?",
        },
      ],
      copy: "Sao chép",
      copied: "Đã chép",
      proofPrefix: "Phiên dịch song ngữ theo thời gian thực, ",
      proofHighlight1: "trợ lý giọng nói có nguồn trích dẫn",
      proofMid: ", và tài liệu cuộc họp trong ",
      proofHighlight2: "hạ tầng riêng của bạn",
      proofCta: "Mở không gian TINA",
    },
    useCases: {
      label: "BỀ MẶT ĐỒNG BỘ & ỨNG DỤNG",
      titleLead: "Một trợ lý xuyên suốt ",
      titleSerif: "trước, trong và sau",
      titleTail: " cuộc họp.",
      sub: "Mọi cuộc họp đều liên thông dữ liệu giữa phòng họp trực tiếp, Google Meet Extension và không gian hậu kỳ 3 cột.",
      surfaces: [
        {
          tag: "Bot trong cuộc họp",
          title: "Ghi âm, dịch & trả lời trực tiếp",
          body: "Tham gia cuộc họp công khai như một thành viên, lưu ghi âm vào kho riêng, nhận dạng người nói và trả lời thành tiếng khi được gọi “Tina ơi”.",
          bestFor: "Phù hợp: Họp nhóm song ngữ · Q&A trực tiếp · Ghi biên bản rảnh tay",
        },
        {
          tag: "GOOGLE MEET EXTENSION",
          title: "Trợ lý nổi ngay trong trình duyệt",
          body: "Theo dõi phụ đề VI + EN thời gian thực, bấm Bắt kịp 60 giây khi lỡ nhịp, hỏi Ask TINA và lưu thẳng câu trả lời có nguồn vào Wiki.",
          bestFor: "Phù hợp: Tập trung hoàn toàn vào cuộc họp, không cần chuyển tab",
        },
        {
          tag: "Không gian sau cuộc họp",
          title: "Biên bản, Talk Time & Routines",
          body: "Tóm tắt điều hành, tìm kiếm thông minh, thống kê thời lượng nói từng người, Ask TINA có duyệt công cụ an toàn và lịch chạy tổng hợp định kỳ.",
          bestFor: "Phù hợp: Theo dõi việc cần làm · Xây Wiki nhóm · Báo cáo tự động",
        },
      ],
      casesHeading: "Tình huống sử dụng",
      cases: [
        {
          num: "01 / ĐỐI TÁC QUỐC TẾ",
          title: "Họp song ngữ Việt – Anh không rào cản",
          body: "Thành viên nói tiếng Việt hay tiếng Anh đều nắm trọn ý tức thì nhờ lớp dịch theo cụm câu hoàn chỉnh và biên bản song ngữ sau họp.",
        },
        {
          num: "02 / SẢN PHẨM & KỸ THUẬT",
          title: "Standup, Review & lưu quyết định vào Wiki",
          body: "Mọi quyết định thiết kế, vướng mắc và đầu việc đều gắn kèm trích dẫn câu nói gốc — tra cứu lại chỉ trong vài giây.",
        },
        {
          num: "03 / KINH DOANH & CSKH",
          title: "Ghi nhận cam kết khách hàng chính xác",
          body: "Gọi “Tina ơi” ngay trong cuộc họp để nhắc lại cam kết các buổi trước, sau họp xuất ngay email follow-up và checklist bàn giao.",
        },
        {
          num: "04 / ĐIỀU HÀNH & QUẢN LÝ",
          title: "Bắt kịp nhanh & theo dõi tiến độ toàn đội",
          body: "Dùng Bắt kịp 60 giây khi vào họp trễ, xem Tóm tắt điều hành, Talk Time và thiết lập Routines gửi báo cáo định kỳ.",
        },
      ],
    },
    privacy: {
      label: "Dữ liệu và quyền truy cập",
      titleLead: "Dữ liệu cuộc họp luôn thuộc ",
      titleSerif: "quyền kiểm soát của bạn.",
      sub: "Quản trị viên cấu hình nơi lưu bản ghi, transcript và tài liệu Wiki. Quyền truy cập phụ thuộc vào quyền sở hữu và cách chia sẻ.",
      cards: [
        {
          tag: "A / HẠ TẦNG RIÊNG BIỆT",
          title: "Kho lưu trữ do quản trị viên cấu hình",
          body: "TINA lưu bản ghi, transcript và Wiki trong cơ sở dữ liệu và kho lưu trữ của bản triển khai.",
        },
        {
          tag: "B / BẢO VỆ KHÓA & PHIÊN",
          title: "Khóa API không bao giờ lộ ra trình duyệt.",
          body: "Toàn bộ khóa mô hình AI, phiên OAuth và token dịch vụ được quản lý hoàn toàn ở máy chủ — trình duyệt không lưu bí mật nhạy cảm.",
        },
        {
          tag: "C / PHÂN QUYỀN CHẶT CHẼ",
          title: "Mặc định riêng tư, không train AI.",
          body: "Chủ cuộc họp và những người được cấp quyền có thể mở transcript.",
        },
      ],
      platformsLabel: "Tích hợp",
      platformsTitleLead: "Kết nối linh hoạt với ",
      platformsTitleSerif: "nền tảng & mô hình",
      platformsTitleTail: " đội ngũ đang dùng.",
      platformsSub: "Hỗ trợ các ứng dụng họp phổ biến nhất cùng khả năng thay đổi mô hình AI và công cụ nhận dạng giọng nói ngay trong phần Cài đặt.",
      leftColTitle: "NỀN TẢNG HỌP & GIAO DIỆN",
      leftColItems: [
        "Google Meet (+ Chrome Extension nổi)",
        "Zoom",
        "Microsoft Teams",
        "TINA Web Workspace",
        "Đồng bộ Google & Outlook Calendar",
        "TINA Developer Terminal (Quản trị)",
      ],
      rightColTitle: "MÔ HÌNH AI & GIỌNG NÓI HỖ TRỢ",
      rightColItems: [
        "ChatGPT Plan (Đăng nhập OAuth)",
        "Claude / Anthropic",
        "Google Gemini & AWS Bedrock",
        "DeepSeek, Groq & Gateway nội bộ",
        "Nhận dạng giọng nói song ngữ VI / EN",
        "Tổng hợp giọng nói tiếng Việt tự nhiên",
      ],
    },
    faq: {
      label: "Câu hỏi thường gặp",
      items: [
        {
          q: "Làm thế nào để bắt đầu đăng nhập TINA?",
          a: "Bạn chỉ cần bấm “Tiếp tục với Google” (hoặc Microsoft nếu tổ chức bật). Trên hệ thống mới cài đặt chưa có quản trị viên, tài khoản đăng nhập đầu tiên sẽ tự động nhận quyền Admin để cấu hình chung cho cả nhóm.",
        },
        {
          q: "Khi tham gia phòng họp, mọi người có thấy TINA Bot không?",
          a: "Có. TINA Bot tham gia phòng họp một cách minh bạch với tên hiển thị rõ ràng trong danh sách người tham gia, chờ chủ phòng duyệt vào và có thể mời rời khỏi phòng bất kỳ lúc nào.",
        },
        {
          q: "Trợ lý giọng nói “Tina ơi” có tự bịa thông tin khi trả lời không?",
          a: "TINA dựa vào transcript và tài liệu bạn có quyền truy cập. Câu trả lời có thể sai hoặc thiếu ngữ cảnh. Mở mục Nguồn khi có để đối chiếu với nội dung gốc.",
        },
        {
          q: "Dữ liệu ghi âm và biên bản cuộc họp được lưu ở đâu?",
          a: "Bản ghi, transcript và Wiki nằm trong kho lưu trữ do quản trị viên cấu hình. Khi tổ chức dùng dịch vụ AI bên ngoài, TINA có thể gửi phần nội dung cần xử lý cho nhà cung cấp đó.",
        },
        {
          q: "Tôi có thể dùng tài khoản ChatGPT Plan hoặc API key AI riêng không?",
          a: "Cài đặt → AI Models & Transcription hiển thị các nhà cung cấp mà quản trị viên đã bật. Kết nối ChatGPT Plan từ trình duyệt chỉ khả dụng trên bản chạy local.",
        },
      ],
    },
    cta: {
      titleLine1: "Sẵn sàng cho cuộc họp",
      titleSerif: "tiếp theo của bạn?",
      sub: "Đăng nhập vào không gian làm việc TINA để họp song ngữ rõ ràng, hỏi đáp bằng giọng nói và biến mọi buổi họp thành hành động cụ thể.",
      primary: "Đăng nhập vào TINA",
      primaryClaim: "Khởi tạo quyền quản trị viên",
      backToTop: "Về đầu trang ↑",
    },
    footer: {
      tagline:
        "Trợ lý họp AI song ngữ Việt – Anh có giọng nói trực tiếp và lưu trữ bảo mật riêng cho Google Meet, Zoom và Microsoft Teams.",
      col1: "Sản phẩm",
      col2: "Tin cậy & Hệ sinh thái",
      col3: "Không gian làm việc",
      col3SignIn: "Đăng nhập",
      col3Claim: "Thiết lập hệ thống",
      col3AuthOptions: "Tùy chọn xác thực",
      copyright: "© 2026 TINA — Trợ lý họp AI cho đội ngũ hiện đại.",
      motto: "Lắng nghe trọn vẹn. Hành động cùng nhau.",
    },
  },

  en: {
    nav: {
      live: "Live Voice",
      extension: "Extension",
      how: "How it works",
      useCases: "Use cases",
      privacy: "Privacy",
      faq: "FAQ",
      signIn: "Sign in",
      claimAdmin: "Claim admin",
      toggleNav: "Toggle navigation",
    },
    hero: {
      claimBadge: "First sign-in = administrator",
      claimHeading: "Set up your instance",
      claimLead:
        "This TINA instance has no administrator yet. The first sign-in becomes the admin to configure AI models, speech transcription, and invite teammates.",
      titleLine1: "An AI teammate",
      titleSerif: "that listens, translates",
      titleMid: " &",
      titleLine3Prefix: "speaks ",
      titleAccent: "in the room.",
      lead: "Follow Vietnamese and English transcripts on Google Meet, Zoom, and Teams. Say “Tina ơi” to ask a question when the voice assistant is enabled.",
      googleCta: "Continue with Google",
      microsoftCta: "Continue with Microsoft",
      secondaryCta: "See TINA in action",
      claimFoot: "This claim screen disappears once an administrator exists.",
      devNoticePrefix: "Development test mode — sign-in is limited to @example.test addresses. Add ",
      devNoticeSuffix: " to enable OAuth.",
      noOAuthClaimNotice: "Configure Google or Microsoft OAuth to sign in. Passwordless test login is disabled outside development.",
      noOAuthNotice: "No OAuth provider is configured on this TINA instance yet. Enable Google or Microsoft OAuth on your server.",
      debugShow: "Debug sign-in (@example.test)",
      debugHide: "Hide debug sign-in",
      directHintClaim: "Email — use an @example.test address (development only).",
      directHintDebug: "Debug login — use an @example.test address.",
      directSubmit: "Sign in",
      directSubmitAdmin: "Sign in as admin",
      directSubmitting: "Signing in…",
    },
    scene: {
      ariaLabel: "Interactive TINA meeting illustration",
      imgAlt: "Hand-drawn illustration of an AI meeting teammate rolling up to a conference table",
      callTina: "Say “Tina ơi”",
      joinTable: "Join table",
      leaveTable: "Step back",
      autoplayOn: "Autoplay",
      autoplayPaused: "Paused",
      demo: "Sample conversation",
      hotspots: {
        minh: "Hear Minh ask about Q4 launch",
        seatedBot: "Trigger TINA Agent summary",
        linh: "Linh says Tina oi",
        lan: "Lan syncs bilingual Wiki",
        rollingBotIn: "Roll TINA bot up to the table",
        rollingBotOut: "Move TINA bot back from table",
      },
      beats: {
        minh: {
          speaker: "Minh · Product",
          badge: "09:40 · VI",
          text: "Enterprise client wants Q4 rollout confirmed before Friday.",
          sub: "Khách hàng Enterprise muốn chốt lịch Q4 trước thứ 6.",
          isAgent: false,
          botSeated: false,
          activeHumanBubble: 1,
          posClass: "posMinh",
        },
        linh: {
          speaker: "Linh · Ops",
          badge: "WAKE WORD",
          text: "“Tina ơi, what did we agree on last week?!”",
          sub: "Waking TINA Voice Agent…",
          isAgent: false,
          botSeated: true,
          activeHumanBubble: 2,
          posClass: "posLinh",
        },
        "tina-reply": {
          speaker: "TINA Agent",
          badge: "SPOKEN · VOICE TTS",
          text: "Two items agreed last week: send the security review Wednesday and start the 20-seat bilingual pilot.",
          sub: "Sources (2) · Cited directly from Nov 18 call",
          isAgent: true,
          botSeated: true,
          activeHumanBubble: null,
          posClass: "posBotSeated",
        },
        lan: {
          speaker: "Lan · Lead",
          badge: "09:41 · VI + EN",
          text: "Spot on — save the bilingual summary straight to the client Wiki!",
          sub: "Synced to shared team Wiki ✓",
          isAgent: false,
          botSeated: true,
          activeHumanBubble: 3,
          posClass: "posJky",
        },
      },
    },
    ticker: {
      label: "TINA highlights",
      pause: "Pause highlights",
      resume: "Resume highlights",
      items: [
        "GOOGLE MEET",
        "ZOOM",
        "MICROSOFT TEAMS",
        "BILINGUAL VI + EN",
        "“TINA ƠI” VOICE AGENT",
        "CHROME EXTENSION",
        "60-SECOND CATCH-UP",
        "ENTERPRISE PRIVACY",
      ],
    },
    live: {
      label: "In the meeting",
      titleLead: "Know who said what — ",
      titleSerif: "and ask TINA out loud.",
      sub: "Live Vietnamese and English transcripts stream with speaker diarization, interleaved directly with TINA Agent’s spoken replies and clickable source citations.",
      shellTitle: "Vietnamese and English transcript",
      columns: { speaker: "Speaker", original: "Original", translation: "Translation" },
      pause: "Pause sample conversation",
      resume: "Resume sample conversation",
      voiceReply: "Spoken reply",
      lines: [
        {
          speaker: "Minh Nguyen",
          role: "Product Lead",
          originalLang: "vi",
          time: "09:40:12",
          primary: "Mình cần chốt lại tiến độ bản phát hành Q4 và phần đánh giá bảo mật cho đối tác Singapore trước thứ 6.",
          secondary: "We need to lock the Q4 release timeline and security review for our Singapore partner by Friday.",
          isAgent: false,
        },
        {
          speaker: "Linh Hoang",
          role: "Operations",
          originalLang: "vi",
          time: "09:40:38",
          primary: "Tina ơi, nhắc lại 2 cam kết tuần trước mình đã thống nhất với đối tác giúp cả nhóm nhé.",
          secondary: "Tina, remind the team of the two commitments we agreed on with the partner last week.",
          isAgent: false,
        },
        {
          speaker: "TINA Agent",
          time: "09:40:44",
          primary:
            "Last week the team locked two commitments: deliver the security assessment on Wednesday and launch a 20-seat bilingual pilot next week.",
          secondary: "Sources (2): 09:40:12 and the Nov 18 meeting notes",
          isAgent: true,
        },
        {
          speaker: "Daniel Lee",
          role: "Partner",
          originalLang: "en",
          time: "09:41:02",
          primary: "Exact match — please save this summary and action list straight to our shared workspace.",
          secondary: "Chính xác — nhờ lưu bản tóm tắt và danh sách đầu việc này thẳng vào không gian làm việc chung nhé.",
          isAgent: false,
        },
      ],
      bullets: [
        "Talk Time: duration, pace, and speaking share by speaker",
        "Vietnamese and English translation by phrase",
        "Voice replies with sources when available",
        "In a recorded meeting, select a line to replay from that timestamp",
      ],
    },
    extension: {
      label: "TINA Chrome Extension",
      titleLead: "Right inside Google Meet — ",
      titleSerif: "without switching tabs.",
      sub: "The TINA Chrome Extension floats cleanly beside your Google Meet call so you can follow bilingual transcripts, catch up on the last 60 seconds, and ask TINA in place.",
      points: [
        {
          tag: "BILINGUAL",
          title: "Live VI + EN side panel inside Meet",
          body: "Groups completed speaker phrases cleanly so original speech and English translation stay effortless to scan.",
        },
        {
          tag: "60 SECONDS",
          title: "One-click 60-second catch-up",
          body: "Stepped away or lost the thread? Summarize the confirmed last minute instantly with exact timestamps.",
        },
        {
          tag: "ASK TINA",
          title: "Grounded Q&A & Save to Wiki",
          body: "Query confirmed transcripts and linked docs, inspect verbatim quotes, and save verified answers straight to your team Wiki.",
        },
        {
          tag: "ZERO CAPTURE",
          title: "No browser microphone or tab capture",
          body: "The extension never asks for mic or tab audio permissions — it only reads owner-authorized data from TINA Bot.",
        },
      ],
      tabs: {
        bilingual: "Bilingual",
        catchup: "Catch up",
        ask: "Ask TINA",
      },
      bilingualRows: [
        {
          speaker: "Minh Nguyen",
          time: "09:40",
          vi: "Bản Q4 ưu tiên mở khóa trải nghiệm họp song ngữ cho khối đối tác.",
          en: "Q4 prioritizes unlocking the bilingual meeting workflow for partner teams.",
        },
        {
          speaker: "Daniel Lee",
          time: "09:41",
          vi: "Nếu có báo cáo bảo mật vào thứ 4 thì chúng tôi sẵn sàng kích hoạt ngay.",
          en: "If the security report lands Wednesday, we are ready to launch immediately.",
        },
      ],
      catchupWindow: "Window 09:40:02 – 09:41:02 · Confirmed transcript",
      catchupSummary: "Team is confirming launch gates for the Q4 Singapore partner rollout:",
      catchupBullets: [
        "Wednesday: Linh sends security review and access matrix.",
        "Next week: 20-seat bilingual pilot kicks off with ops.",
        "Status: Partner aligned on Friday sign-off pending security pack.",
      ],
      askQuestion: "What does our partner need before Friday sign-off?",
      askAnswer: "The partner requires the security assessment by Wednesday plus the 20-seat bilingual pilot roster.",
      askCitation: "Sources (2) · 09:40:12 (Minh Nguyen) · 09:41:02 (Daniel Lee)",
      askWikiBtn: "Save to Wiki",
      askWikiSaved: "Simulated Wiki save",
    },
    how: {
      label: "Setup",
      titleLine1: "One Google sign-in.",
      titleSerif: "TINA",
      titleLine2Rest: " is in your meeting.",
      sub: "Sign in, check which models are enabled, and send TINA to a supported meeting.",
      steps: [
        {
          kicker: "SIGN IN",
          title: "Connect your workspace.",
          body: "Sign in with Google to open your personal or team notebook. Link Google or Outlook calendars so upcoming calls sync automatically.",
        },
        {
          kicker: "MODELS",
          title: "Pick your own AI & speech.",
          body: "Check Settings for the AI models and speech services enabled for your workspace.",
        },
        {
          kicker: "JOIN CALL",
          title: "Send TINA & speak live.",
          body: "Paste a Google Meet, Zoom, or Teams link — or click Send Bot from Chrome Extension. Summon TINA aloud anytime:",
          wakePrompt: "Tina ơi, what did we agree on last week?",
        },
      ],
      copy: "Copy",
      copied: "Copied",
      proofPrefix: "Real-time bilingual translation, ",
      proofHighlight1: "source-cited voice answers",
      proofMid: ", and searchable meeting memory — running inside ",
      proofHighlight2: "your own private infrastructure",
      proofCta: "Open TINA workspace",
    },
    useCases: {
      label: "SYNCED SURFACES & USE CASES",
      titleLead: "One companion across ",
      titleSerif: "before, during & after",
      titleTail: " every call.",
      sub: "Every meeting stays continuously synced across the live call bot, Google Meet Extension, and 3-column post-call workspace.",
      surfaces: [
        {
          tag: "IN-CALL VOICE BOT",
          title: "Captures, translates & speaks",
          body: "Joins visibly as a meeting participant, stores recordings privately, labels speakers, and answers out loud when addressed as “Tina ơi”.",
          bestFor: "Best for: Bilingual teams · Live Q&A · Hands-free minutes",
        },
        {
          tag: "GOOGLE MEET EXTENSION",
          title: "Floating in-call assistant",
          body: "Follow live VI + EN phrases, hit 60-second catch-up when joining late, query Ask TINA, and save cited answers straight to Wiki.",
          bestFor: "Best for: Staying present inside Google Meet with zero tab switching",
        },
        {
          tag: "3-COLUMN WORKSPACE",
          title: "Notes, Talk Time & Routines",
          body: "Executive summary, Smart Search, Speaker Talk Time analytics, Ask TINA with explicit tool approvals, and scheduled Routines.",
          bestFor: "Best for: Action follow-ups · Shared team Wiki · Automated recaps",
        },
      ],
      casesHeading: "Example use cases",
      cases: [
        {
          num: "01 / GLOBAL PARTNERS",
          title: "Effortless VI + EN bilingual meetings",
          body: "Whether speakers use Vietnamese or English, everyone follows in real time with phrase-level translation and a clean bilingual recap.",
        },
        {
          num: "02 / PRODUCT & ENGINEERING",
          title: "Standups, reviews & verifiable Wiki decisions",
          body: "Every decision, blocker, and action item links straight back to the exact spoken quote so nothing gets lost between sprints.",
        },
        {
          num: "03 / SALES & CUSTOMER SUCCESS",
          title: "Accurate client commitments & instant follow-ups",
          body: "Ask “Tina ơi” mid-call to recall prior commitments, then generate grounded follow-up emails and handoff checklists right after wrapping.",
        },
        {
          num: "04 / LEADERSHIP & OPS",
          title: "Instant catch-up & cross-team visibility",
          body: "Use 60-second catch-up when joining late, review Talk Time balance and executive summaries, and automate recurring digest Routines.",
        },
      ],
    },
    privacy: {
      label: "Data and access",
      titleLead: "Your meetings stay ",
      titleSerif: "under your control.",
      sub: "Your administrator configures where recordings, transcripts, and Wiki documents are stored. Access follows ownership and sharing permissions.",
      cards: [
        {
          tag: "A / PRIVATE INFRASTRUCTURE",
          title: "Storage configured by your administrator",
          body: "TINA stores recordings, transcripts, and team Wikis in the database and storage configured for the deployment.",
        },
        {
          tag: "B / SERVER-SIDE CREDENTIALS",
          title: "Keys never touch the browser.",
          body: "LLM API keys, OAuth tokens, and service secrets stay strictly on your server — never exposed to client-side JavaScript.",
        },
        {
          tag: "C / DEFAULT-DENY ACCESS",
          title: "Transcript access follows sharing permissions",
          body: "Meeting owners and people granted access can view transcripts.",
        },
      ],
      platformsLabel: "Integrations",
      platformsTitleLead: "Works with the ",
      platformsTitleSerif: "platforms & models",
      platformsTitleTail: " your team already trusts.",
      platformsSub: "Join the meeting tools your organization runs on and swap AI or speech providers anytime right from Settings.",
      leftColTitle: "MEETING PLATFORMS & CLIENTS",
      leftColItems: [
        "Google Meet (+ floating Chrome Extension)",
        "Zoom",
        "Microsoft Teams",
        "TINA Web Workspace",
        "Google & Outlook Calendar Sync",
        "TINA Developer Terminal (Admin)",
      ],
      rightColTitle: "SUPPORTED AI & SPEECH ENGINES",
      rightColItems: [
        "ChatGPT Plan (OAuth Sign-in)",
        "Claude / Anthropic",
        "Google Gemini & AWS Bedrock",
        "DeepSeek, Groq & Custom Gateways",
        "Real-time Bilingual VI / EN Transcription",
        "Natural Vietnamese & English Voice TTS",
      ],
    },
    faq: {
      label: "Frequently asked questions",
      items: [
        {
          q: "How do I sign in to TINA?",
          a: "Click “Continue with Google” (or Microsoft if enabled by your organization). On a brand-new instance with no administrator yet, the first account to sign in automatically becomes the admin.",
        },
        {
          q: "Is TINA Bot visible to everyone in the meeting?",
          a: "Yes. TINA Bot joins transparently with a clear display name in the participant list, waits for host admission, and can be removed at any time.",
        },
        {
          q: "Does the “Tina ơi” voice assistant ever hallucinate facts?",
          a: "TINA uses the transcript and documents you can access. Replies can be wrong or miss context. Open Sources when available to check the original material.",
        },
        {
          q: "Where are recordings and transcripts stored?",
          a: "Recordings, transcripts, and Wiki content are stored in the services configured by your administrator. When an external AI service is enabled, TINA can send it the context needed to process the request.",
        },
        {
          q: "Can I bring my own ChatGPT Plan or AI API keys?",
          a: "Settings → AI Models & Transcription lists the providers enabled by your administrator. Browser-based ChatGPT Plan sign-in is available on local installs.",
        },
      ],
    },
    cta: {
      titleLine1: "Ready for your",
      titleSerif: "next meeting?",
      sub: "Sign in to your private TINA workspace to run clearer bilingual meetings, ask TINA aloud, and turn every conversation into verifiable action.",
      primary: "Sign in to TINA",
      primaryClaim: "Claim administrator access",
      backToTop: "Back to top ↑",
    },
    footer: {
      tagline:
        "Bilingual VI + EN AI meeting teammate with live voice answers and private infrastructure control for Google Meet, Zoom, and Microsoft Teams.",
      col1: "Product",
      col2: "Trust & Ecosystem",
      col3: "Workspace",
      col3SignIn: "Sign in",
      col3Claim: "Set up instance",
      col3AuthOptions: "Authentication options",
      copyright: "© 2026 TINA — AI Meeting Companion for modern teams.",
      motto: "Listen clearly. Act together.",
    },
  },
};
