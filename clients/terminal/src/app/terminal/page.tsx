/** `/terminal` — the TINA Terminal dev workbench (Dockview 3-pane shell). */
import { App } from "../App";
import { canUseWorkspacePilot } from "../api/auth/workspacePilot";
import { redirect } from "next/navigation";

export default async function TerminalPage() {
  if (!(await canUseWorkspacePilot())) redirect("/");
  return <App />;
}
