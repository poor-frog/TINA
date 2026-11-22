# Ask TINA trong Google Meet

Người dùng đồng ý triển khai đề xuất ngay trước đó bằng lời “ok thực thi cho tôi”.
Hướng đã chọn là chat một cột với ô hỏi ghim đáy, gợi ý khi chưa hỏi, trích dẫn thu gọn và Open Terminal trong menu thao tác.

Bố cục dùng trực tiếp logo và bảng màu trong `branding/tokens.css` của TINA. Tham chiếu Fireflies là cách hỏi ngay trong cuộc họp của [Live Assist](https://guide.fireflies.ai/articles/7077919424-explore-the-real-time-pane-on-the-fireflies-chrome-extension).

## TINA Extension sign-in popup

The comparison showed [Midnight Navy](design-demos/a-xanh-dem.png), [Peach and Mint](design-demos/b-dao-va-mint.png), and [Cream and Cobalt](design-demos/c-kem-va-xanh.png) in [one comparison image](design-demos/so-sanh-popup.png).

User selection: “tôi chọn Xanh đêm — ảnh cuộc họp tràn ngang, vùng đăng nhập sáng và dễ nhận ra. và tôi muốn viết lại bằng tiếng Anh”

Apply the full-width meeting illustration and light sign-in area from Midnight Navy. Use English for the popup copy and status messages. The meeting image spans the popup like the meeting stage it depicts. The light section makes the next action easy to spot at a glance.

## Signed-in toolbar popup

The [comparison](design-demos/toolbar-popup/compare-toolbar.png) showed Midnight Navy ([Home](design-demos/toolbar-popup/a-midnight-home.png), [My meetings](design-demos/toolbar-popup/a-midnight-meetings.png)), Light Ledger ([Home](design-demos/toolbar-popup/b-ledger-home.png), [My meetings](design-demos/toolbar-popup/b-ledger-meetings.png)) and Notebook ([Home](design-demos/toolbar-popup/c-notebook-home.png), [My meetings](design-demos/toolbar-popup/c-notebook-meetings.png)).

User selection: “tôi chọn hướng B nhưng tôi muốn là svg thay vì chữ "settings"”

Use English and an icon-only Settings action with an accessible name. The meeting list uses the existing account-scoped session and separates the meeting identity from its status for quick scanning.
