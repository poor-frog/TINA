/** `/terminal` — the TINA Terminal dev workbench (Dockview 3-pane shell). */
import { App } from "../App";
import { requireAdmin } from "../api/admin/gate";
import { redirect } from "next/navigation";

// Admin verification is only known at request time.
export const dynamic = "force-dynamic";

export default async function TerminalPage() {
  if (process.env.NEXT_PUBLIC_SHOW_TERMINAL_SWITCH !== "1" && !(await requireAdmin())) {
    redirect("/");
  }
  return <App />;
}
