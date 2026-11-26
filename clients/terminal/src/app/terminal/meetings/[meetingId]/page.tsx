/** `/terminal/meetings/<id>` — addressable meeting deep-link inside the dev Terminal workbench. */
import { App } from "../../../App";
import { requireAdmin } from "../../../api/admin/gate";
import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function TerminalMeetingPage() {
  if (process.env.NEXT_PUBLIC_SHOW_TERMINAL_SWITCH !== "1" && !(await requireAdmin())) {
    redirect("/");
  }
  return <App />;
}
