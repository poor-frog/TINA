/** `/terminal` — the TINA Terminal dev workbench (Dockview 3-pane shell). */
import { App } from "../App";
import { canUseWorkspacePilot } from "../api/auth/workspacePilot";
import { redirect } from "next/navigation";

// The pilot stage and session are only known at request time.
export const dynamic = "force-dynamic";

export default async function TerminalPage() {
  if (!(await canUseWorkspacePilot())) redirect("/");
  return <App />;
}
