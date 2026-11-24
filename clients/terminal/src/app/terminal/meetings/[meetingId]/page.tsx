/** `/terminal/meetings/<id>` — addressable meeting deep-link inside the dev Terminal workbench. */
import { App } from "../../../App";
import { canUseWorkspacePilot } from "../../../api/auth/workspacePilot";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function TerminalMeetingPage() {
  if (!(await canUseWorkspacePilot())) redirect("/");
  return <App />;
}
