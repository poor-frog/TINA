"use client";
// Lucian UX/UI Prompt #455 · MIT License (c) 2026 Seokwoooo · https://lucianlabs.dev/uxui-prompt/#455
import type { ToolApprovalDecision, ToolApprovalState } from "../../workbench/toolApproval";
import "./lucian-455.css";

function mapState(status: ToolApprovalState["status"]): "ask" | "run" | "ok" | "no" {
  if (status === "pending") return "ask";
  if (status === "submitting") return "run";
  if (status === "approved") return "ok";
  return "no";
}

function statusText(status: ToolApprovalState["status"]): string {
  switch (status) {
    case "submitting":
      return "Sending decision…";
    case "approved":
      return "Approved for this call";
    case "denied":
      return "Denied";
    case "expired":
      return "Approval expired; the tool was not called";
    case "cancelled":
      return "Approval cancelled";
    default:
      return "";
  }
}

export function LucianToolApprovalCard({
  approval,
  onDecision,
}: {
  approval: ToolApprovalState;
  onDecision: (approvalId: string, decision: ToolApprovalDecision) => void;
}) {
  const dataState = mapState(approval.status);
  const isPending = dataState === "ask";
  const toolSlug = `${approval.server}/${approval.tool}`;
  const lineStatus = statusText(approval.status);

  return (
    <div className="ux u455" data-testid="lucian-tool-approval">
      <section
        className="u455-c"
        data-s={dataState}
        role="group"
        aria-label={`Approval required: ${approval.title}`}
      >
        <div className="u455-full-wrap" aria-hidden={!isPending || undefined}>
          <div className="u455-full-inner">
            <div className="u455-full">
              <div className="u455-hd">
                <span className="u455-tl" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d="m6.5 8 4 4-4 4M12.5 16.5h5" />
                  </svg>
                </span>
                <span className="u455-tt">
                  <b>{approval.title}</b>
                  <small>{approval.description || "Tina needs your permission to run this action"}</small>
                </span>
              </div>

              <div className="u455-cd">
                <span aria-hidden="true">$</span>
                <code>{toolSlug}</code>
              </div>

              {approval.message && <div className="u455-msg">{approval.message}</div>}

              {approval.parameters.length > 0 && (
                <dl className="u455-params">
                  {approval.parameters.map((param) => (
                    <div key={param.name} className="u455-param-row">
                      <dt>{param.display_name}</dt>
                      <dd>{param.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {approval.error && (
                <div role="alert" className="u455-err">
                  {approval.error}
                </div>
              )}

              {isPending && (
                <div className="u455-ft">
                  <button
                    type="button"
                    className="u455-b u455-no"
                    onClick={() => onDecision(approval.approval_id, "deny")}
                  >
                    Deny
                  </button>
                  <button
                    type="button"
                    className="u455-b u455-ok"
                    onClick={() => onDecision(approval.approval_id, "approve")}
                  >
                    Approve once
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>

        {!isPending && (
          <p className="u455-line" role="status">
            <span className="u455-li" aria-hidden="true">
              <i className="u455-sp" />
              <span className="u455-ck">
                <svg viewBox="0 0 24 24">
                  <path d="m6 12.5 4 4 8-9" />
                </svg>
              </span>
              <span className="u455-xx">
                <svg viewBox="0 0 24 24">
                  <path d="M7 7l10 10M17 7 7 17" />
                </svg>
              </span>
            </span>
            <code className="u455-lc">{toolSlug}</code>
            <span className="u455-lt">{lineStatus}</span>
          </p>
        )}
      </section>
    </div>
  );
}
