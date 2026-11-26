export type ChatGPTPlanIssue = "usage_limit" | "reconnect_required";

export function ChatGPTPlanNotice({ issue }: { issue?: ChatGPTPlanIssue | null }) {
  if (issue === "reconnect_required") {
    return <p role="alert">Kết nối ChatGPT plan cần được cấp quyền lại. Hãy kết nối lại ChatGPT trước khi hỏi TINA.</p>;
  }
  if (issue === "usage_limit") {
    return <p role="alert">ChatGPT plan đang giới hạn lượt sử dụng. Kiểm tra <a href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer">hạn mức ChatGPT</a> rồi thử lại.</p>;
  }
  return null;
}
