"use client";
/** MeetingPrepWorkspace — Full Pre-meeting Brief Studio inside Web `/meetings/[meetingId]`.
 *  Unites editable meeting setup, attendees, workspace binding/invite sharing, live-updating
 *  Private (`kg/entities/meeting/brief-*.md`) or Team (`README.md`) Brief stage, Planned Live
 *  Assist Goal & Draft Agenda, and an inline live Brief Assistant SSE chat synced to the Brief. */
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { WebIcon } from "./Icons";
import { AgentActivitySteps } from "./AgentActivitySteps";
import { LucianThinkingText } from "./lucian/LucianThinkingText";
import { LucianToolApprovalCard } from "./lucian/LucianToolApprovalCard";
import { emitWebToast } from "./lucian/webToast";
import { notifyBriefChanged } from "./useOwnBriefIndex";
import { Markdown } from "../ui-kit/Markdown";
import { DateTimePicker } from "../ui-kit/DateTimePicker";
import { presentError, readApiFailure } from "../surfaces/apiClient";
import { briefNotePath, findBriefNote, isExampleNote } from "../surfaces/briefNote";
import { stripContextBlocks } from "../surfaces/chat";
import { browserTz, meetingFocusFor, type MeetingFocus } from "../surfaces/chatContext";
import { streamChatTurn, type ChatPhase } from "../surfaces/chatStream";
import { defaultBotName } from "../surfaces/defaultBotName";
import { refreshMeetings, seedLiveMeetingFromResponse } from "../surfaces/liveMeetings";
import { EMPTY_LIVE_ASSIST_DRAFT, writePlannedLiveAssistDraft } from "../surfaces/liveMeetingStateApi";
import { meetingUrlFor, parseMeetingInput } from "../surfaces/meetingId";
import type { MeetingMock } from "../surfaces/meetingModel";
import { deletePlannedMeeting, updatePlannedMeeting } from "../surfaces/plannedApi";
import {
  PlannedLiveAssistAgenda,
  PlannedLiveAssistGoal,
  PlannedLiveAssistProvider,
} from "../surfaces/PlannedLiveAssistEditor";
import { resolveJoinError, type ServiceDenialPresentation } from "../surfaces/serviceDenial";
import { ServiceDenialPanel } from "../surfaces/ServiceDenialPanel";
import { sessionHistory } from "../surfaces/sessionsApi";
import {
  createSharedWorkspace,
  listSharedMemberships,
  listWorkspaceTree,
  mintInvite,
  readActiveSet,
  readWorkspaceFile,
  type Membership,
} from "../surfaces/workspaceApi";
import type { ToolApprovalDecision, ToolApprovalState } from "../workbench/toolApproval";
import styles from "./meetingPrepWorkspace.module.css";

const BRIEF_POLL_MS = 12_000;
const S3_SYNC_SETTLE_DELAYS_MS = [1_800, 4_200] as const;
const SEED_README_MARK = "This is your **Personal workspace**";
const BRIEF_REPLY_SENTINEL = "<!--tina:brief-reply-->";

interface OwnBriefNote {
  path: string;
  text: string;
  slug: string;
  workspacePath: string;
}

interface PrepChatMessage {
  id: string;
  role: "user" | "agent";
  text: string;
  displayText?: string;
  ops?: string[];
  approvals?: ToolApprovalState[];
  commit?: string;
  error?: string;
}

function shortWorkspaceLabel(workspaceId: string): string {
  return workspaceId.replace(/-[0-9a-f]{4,}$/i, "");
}

function platformSlugFor(platform: string): string {
  return platform === "Google Meet" ? "google_meet" : platform.toLowerCase().replace(/\s+/g, "_");
}

function stripYamlFrontmatter(raw: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return raw;
  const end = normalized.indexOf("\n---", 4);
  if (end === -1) return raw;
  const after = normalized.slice(end + 4).replace(/^\n+/, "");
  return after || raw;
}

function summarizeKickoffPrompt(raw: string): string {
  const cleaned = stripContextBlocks(raw).trim();
  const replyIdx = cleaned.indexOf(BRIEF_REPLY_SENTINEL);
  if (replyIdx !== -1) {
    const tail = cleaned.slice(replyIdx + BRIEF_REPLY_SENTINEL.length).trim();
    if (tail) return tail;
  }
  if (/^Interview me to build the brief for /i.test(cleaned)) {
    return "Start private brief interview";
  }
  if (/^I just created the shared workspace /i.test(cleaned)) {
    return "Scaffold team brief in shared workspace";
  }
  if (/^Prepare the brief for /i.test(cleaned)) {
    return "Draft & update team brief";
  }
  return cleaned;
}

export function MeetingPrepWorkspace({
  meeting,
  meetingsOnly,
  firstName,
  autoStartBrief = false,
  onConsumeAutoStartBrief,
  onBack,
  onOpenMeeting,
  onOpenKnowledgeDoc,
  onUpdated,
}: {
  meeting: MeetingMock;
  meetingsOnly: boolean;
  firstName: string;
  autoStartBrief?: boolean;
  onConsumeAutoStartBrief?: () => void;
  onBack: () => void;
  onOpenMeeting?: (meetingId: string) => void;
  onOpenKnowledgeDoc?: (docPath: string, wsSlug?: string) => void;
  onUpdated: () => void;
}) {
  const readOnly = !!meeting.shared;
  const headline = useMemo(() => meeting.title_custom || meeting.title || "Planned meeting", [meeting]);
  const sessionId = `brief-${meeting.id}`;

  // Editable form state synced per meeting ID
  const [title, setTitle] = useState(meeting.title_custom ?? meeting.title ?? "");
  const [meetingUrl, setMeetingUrl] = useState(meeting.meeting_url ?? "");
  const [scheduledAt, setScheduledAt] = useState(meeting.scheduled_at ?? "");
  const [autoJoin, setAutoJoin] = useState(meeting.auto_join !== false);
  const [savingField, setSavingField] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [denial, setDenial] = useState<ServiceDenialPresentation | null>(null);

  // Shared workspace state
  const [shares, setShares] = useState<Membership[]>([]);
  const [rebindOpen, setRebindOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [copiedInvite, setCopiedInvite] = useState(false);

  // Brief state (shared README vs private brief note)
  const [briefRefreshTick, setBriefRefreshTick] = useState(0);
  const [sharedBriefState, setSharedBriefState] = useState<"loading" | "none" | "ready">("loading");
  const [sharedBriefText, setSharedBriefText] = useState<string | null>(null);
  const [ownBrief, setOwnBrief] = useState<OwnBriefNote | null>(null);
  const [ownBriefLoading, setOwnBriefLoading] = useState(false);
  const [briefError, setBriefError] = useState("");
  const [briefChatStarted, setBriefChatStarted] = useState(false);

  // Inline Brief Assistant chat state
  const [messages, setMessages] = useState<PrepChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatPhase, setChatPhase] = useState<ChatPhase | null>(null);
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);

  const mountedRef = useRef(true);
  const abortRef = useRef<AbortController | null>(null);
  const settleTimersRef = useRef<number[]>([]);
  const savedTimerRef = useRef<number | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<PrepChatMessage[]>(messages);
  messagesRef.current = messages;
  const hadBriefRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current?.abort();
      abortRef.current = null;
      for (const timer of settleTimersRef.current) window.clearTimeout(timer);
      settleTimersRef.current = [];
      if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    };
  }, []);

  // Re-seed editable fields only when meeting ID changes
  useEffect(() => {
    setTitle(meeting.title_custom ?? meeting.title ?? "");
    setMeetingUrl(meeting.meeting_url ?? "");
    setScheduledAt(meeting.scheduled_at ?? "");
    setAutoJoin(meeting.auto_join !== false);
    setInviteLink(null);
    setRebindOpen(false);
    setMoreOpen(false);
    setErr(null);
    setDenial(null);
    setBriefChatStarted(false);
    hadBriefRef.current = false;
  }, [meeting.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load bindable shared workspaces
  const loadShares = useCallback(() => {
    if (meetingsOnly || readOnly) return;
    void listSharedMemberships()
      .then((ms) => {
        if (mountedRef.current) {
          setShares(ms.filter((s) => s.role === "owner" || s.role === "contributor"));
        }
      })
      .catch(() => undefined);
  }, [meetingsOnly, readOnly]);

  useEffect(() => {
    loadShares();
  }, [loadShares]);

  const scheduleBriefRefresh = useCallback((immediate = true) => {
    if (immediate) setBriefRefreshTick((t) => t + 1);
    for (const timer of settleTimersRef.current) window.clearTimeout(timer);
    settleTimersRef.current = S3_SYNC_SETTLE_DELAYS_MS.map((delayMs) =>
      window.setTimeout(() => {
        if (mountedRef.current) setBriefRefreshTick((t) => t + 1);
      }, delayMs),
    );
  }, []);

  // Poll shared workspace README.md when bound
  useEffect(() => {
    if (!meeting.workspace_id || meetingsOnly) {
      setSharedBriefState("none");
      setSharedBriefText(null);
      return;
    }
    let alive = true;
    let serial = 0;
    const slug = meeting.workspace_id;
    setBriefError("");
    if (sharedBriefText === null) setSharedBriefState("loading");

    const load = () => {
      const ticket = ++serial;
      return readWorkspaceFile("README.md", { slug })
        .then((text) => {
          if (!alive || ticket !== serial) return;
          setBriefError("");
          if (!text || !text.trim() || text.slice(0, 400).includes(SEED_README_MARK)) {
            setSharedBriefText(null);
            setSharedBriefState("none");
          } else {
            setSharedBriefText(text);
            setSharedBriefState("ready");
            if (!hadBriefRef.current) {
              hadBriefRef.current = true;
              notifyBriefChanged();
            }
          }
        })
        .catch(() => {
          if (alive && ticket === serial) {
            setBriefError("Could not read the shared brief. Retry in a moment.");
            setSharedBriefState("none");
          }
        });
    };

    void load();
    const refresh = () => {
      if (document.visibilityState === "visible") void load();
    };
    const interval = window.setInterval(refresh, BRIEF_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [meeting.id, meeting.workspace_id, meetingsOnly, briefRefreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll private brief note when unbound
  useEffect(() => {
    if (meeting.workspace_id || readOnly || meetingsOnly) {
      setOwnBrief(null);
      setOwnBriefLoading(false);
      return;
    }
    let alive = true;
    let serial = 0;
    setBriefError("");
    setOwnBriefLoading((prev) => prev || ownBrief === null);

    const look = async () => {
      const ticket = ++serial;
      try {
        const mounts = (await readActiveSet()).active.filter((mount) => mount.role === "private" && mount.write);
        const trees = await Promise.all(
          mounts.map(async (mount) => ({ mount, files: await listWorkspaceTree({ slug: mount.slug }) })),
        );
        const canonical = [
          briefNotePath({ meetingId: meeting.id }),
          briefNotePath({ meetingId: meeting.id, nativeId: meeting.native_id }),
        ];
        const rank = (files: string[]) => {
          const position = canonical.findIndex((path) => files.includes(path));
          return position < 0 ? 2 : position;
        };
        const ordered = trees.sort((a, b) => rank(a.files) - rank(b.files));
        for (const { mount, files } of ordered) {
          const path = findBriefNote(files, {
            title: headline,
            nativeId: meeting.native_id,
            meetingId: meeting.id,
          });
          if (!path) continue;
          const text = await readWorkspaceFile(path, { slug: mount.slug });
          if (!text?.trim() || isExampleNote(text)) continue;
          if (alive && ticket === serial) {
            setOwnBrief({ path, text, slug: mount.slug, workspacePath: mount.path });
            setOwnBriefLoading(false);
            setBriefError("");
            if (!hadBriefRef.current) {
              hadBriefRef.current = true;
              notifyBriefChanged();
            }
          }
          return;
        }
        if (alive && ticket === serial) {
          setOwnBrief(null);
          setOwnBriefLoading(false);
          setBriefError("");
        }
      } catch {
        if (alive && ticket === serial) {
          setOwnBriefLoading(false);
          setBriefError("Could not check your private brief. Retry in a moment.");
        }
      }
    };

    void look();
    const refresh = () => {
      if (document.visibilityState === "visible") void look();
    };
    const interval = window.setInterval(refresh, BRIEF_POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      alive = false;
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
    };
  }, [meeting.id, meeting.native_id, meeting.workspace_id, headline, readOnly, meetingsOnly, briefRefreshTick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Hydrate persisted Brief Assistant session history for this meeting
  useEffect(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setMessages([]);
    setDraft("");
    setChatBusy(false);
    setChatPhase(null);
    if (meetingsOnly) return;

    let alive = true;
    const controller = new AbortController();
    void sessionHistory(sessionId, controller.signal)
      .then((entries) => {
        if (!alive || !Array.isArray(entries) || entries.length === 0) return;
        const hydrated: PrepChatMessage[] = entries
          .filter((entry) => entry.role === "user" || entry.role === "assistant")
          .map((entry, idx) => {
            const role: "user" | "agent" = entry.role === "user" ? "user" : "agent";
            return {
              id: `hist-${sessionId}-${idx}`,
              role,
              text: entry.text,
              displayText: role === "user" ? summarizeKickoffPrompt(entry.text) : undefined,
            };
          });
        if (hydrated.length > 0) {
          setMessages(hydrated);
          setBriefChatStarted(true);
        }
      })
      .catch(() => undefined);

    return () => {
      alive = false;
      controller.abort();
    };
  }, [sessionId, meetingsOnly]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView?.({ behavior: "smooth", block: "end" });
  }, [messages, chatPhase]);

  const markSaved = useCallback(() => {
    setSavedNotice(true);
    if (savedTimerRef.current !== null) window.clearTimeout(savedTimerRef.current);
    savedTimerRef.current = window.setTimeout(() => {
      savedTimerRef.current = null;
      if (mountedRef.current) setSavedNotice(false);
    }, 2000);
  }, []);

  const patchMeeting = useCallback(
    async (body: Parameters<typeof updatePlannedMeeting>[1]) => {
      if (readOnly) return;
      setSavingField(true);
      setErr(null);
      try {
        await updatePlannedMeeting(meeting.id, body);
        onUpdated();
        markSaved();
      } catch (e) {
        if (mountedRef.current) setErr(presentError(e).headline);
      } finally {
        if (mountedRef.current) setSavingField(false);
      }
    },
    [meeting.id, readOnly, onUpdated, markSaved],
  );

  // Send a prompt to the inline Brief Assistant with exact `meetingPrep` grounding
  const sendBriefPrompt = useCallback(
    async (
      rawPrompt: string,
      options?: { displayText?: string; workspaceOverride?: string; focusOverride?: Partial<MeetingFocus> },
    ) => {
      const wirePrompt = rawPrompt.trim();
      if (!wirePrompt || abortRef.current || meetingsOnly) return;

      const userId = `u-${Date.now()}`;
      const agentId = `a-${Date.now() + 1}`;
      setMessages((prev) => [
        ...prev,
        {
          id: userId,
          role: "user",
          text: wirePrompt,
          displayText: options?.displayText,
        },
        { id: agentId, role: "agent", text: "", ops: [], approvals: [] },
      ]);
      setDraft("");
      setChatBusy(true);
      setChatPhase("connecting");

      const controller = new AbortController();
      abortRef.current = controller;

      const workspaceId = options?.workspaceOverride ?? meeting.workspace_id;
      const baseFocus = meetingFocusFor({
        ...meeting,
        title_custom: title.trim() || meeting.title_custom,
        live_status: meeting.live_status ?? "idle",
      });
      const activeFocus: MeetingFocus = {
        ...baseFocus,
        platform: platformSlugFor(meeting.platform),
        ...(meeting.scheduled_at ? { scheduled_at: meeting.scheduled_at } : {}),
        ...(workspaceId ? { workspace_id: workspaceId } : {}),
        ...(options?.focusOverride ?? {}),
      };

      let sawTools = false;
      let sawCommit = false;

      try {
        await streamChatTurn(
          {
            prompt: wirePrompt,
            session: sessionId,
            active: activeFocus,
            context: {
              tz: browserTz() || "UTC",
              surface: { list: "meetings", tab: { kind: "meetingPrep" } },
              focus: activeFocus,
            },
          },
          {
            onStarting: () => {
              if (!controller.signal.aborted) setChatPhase("connecting");
            },
            onStatus: (nextPhase) => {
              if (!controller.signal.aborted) setChatPhase(nextPhase);
            },
            onDelta: (chunk) => {
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, text: m.text + chunk } : m)),
              );
            },
            onTool: (op) => {
              sawTools = true;
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId ? { ...m, ops: [...(m.ops ?? []), op] } : m,
                ),
              );
            },
            onApprovalRequest: (request) => {
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) => {
                  if (m.id !== agentId) return m;
                  if (m.approvals?.some((a) => a.approval_id === request.approval_id)) return m;
                  return {
                    ...m,
                    approvals: [...(m.approvals ?? []), { ...request, status: "pending" }],
                  };
                }),
              );
            },
            onApprovalResolved: (resolved) => {
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId
                    ? {
                        ...m,
                        approvals: m.approvals?.map((a) =>
                          a.approval_id === resolved.approval_id
                            ? { ...a, status: resolved.outcome, error: undefined }
                            : a,
                        ),
                      }
                    : m,
                ),
              );
            },
            onCommit: (sha) => {
              sawCommit = true;
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, commit: sha || "saved" } : m)),
              );
              notifyBriefChanged();
              scheduleBriefRefresh(true);
            },
            onReply: (reply) => {
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, text: reply || m.text } : m)),
              );
              if (sawTools || sawCommit) {
                scheduleBriefRefresh(true);
              }
            },
            onRejected: () => {
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId
                    ? { ...m, error: "Workspace governance rejected changes from this turn." }
                    : m,
                ),
              );
            },
            onModelFailure: (reply) => {
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === agentId
                    ? { ...m, error: reply || "Model inference failed. Check Settings → AI Models." }
                    : m,
                ),
              );
            },
            onError: (message) => {
              if (controller.signal.aborted) return;
              setMessages((prev) =>
                prev.map((m) => (m.id === agentId ? { ...m, error: message } : m)),
              );
            },
          },
          { signal: controller.signal },
        );
      } catch (e) {
        if (!controller.signal.aborted) {
          const msg = presentError(e).headline;
          setMessages((prev) =>
            prev.map((m) => (m.id === agentId ? { ...m, error: msg } : m)),
          );
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
        if (mountedRef.current) {
          setChatBusy(false);
          setChatPhase(null);
        }
      }
    },
    [meeting, meetingsOnly, scheduleBriefRefresh, sessionId, title],
  );

  const respondToApproval = async (approvalId: string, decision: ToolApprovalDecision) => {
    const turn = messagesRef.current.find(
      (m) => m.role === "agent" && m.approvals?.some((a) => a.approval_id === approvalId),
    );
    const approval = turn?.approvals?.find((a) => a.approval_id === approvalId);
    if (!turn || !approval || approval.status !== "pending") return;

    setMessages((prev) =>
      prev.map((m) =>
        m.id === turn.id
          ? {
              ...m,
              approvals: m.approvals?.map((a) =>
                a.approval_id === approvalId ? { ...a, status: "submitting", error: undefined } : a,
              ),
            }
          : m,
      ),
    );

    try {
      const response = await fetch("/api/chat/approval", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          session: sessionId,
          approval_id: approvalId,
          turn_id: approval.turn_id,
          decision,
        }),
      });
      if (!response.ok) throw new Error(`Approval failed (${response.status})`);
    } catch {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === turn.id
            ? {
                ...m,
                approvals: m.approvals?.map((a) =>
                  a.approval_id === approvalId && a.status === "submitting"
                    ? { ...a, status: "pending", error: "Could not send your decision. Try again." }
                    : a,
                ),
              }
            : m,
        ),
      );
    }
  };

  // Canonical Frame-6 Private Brief interview
  const startBriefChat = useCallback(async () => {
    if (meetingsOnly || readOnly || chatBusy) return;
    setBusyAction(true);
    setErr(null);
    try {
      const name = title.trim() || headline;
      const nid = meeting.native_id;
      const mounts = (await readActiveSet()).active.filter((mount) => mount.role === "private" && mount.write);
      const mount = ownBrief
        ? mounts.find((m) => m.slug === ownBrief.slug)
        : mounts.find((m) => m.primary) || mounts[0];
      if (!mount) {
        throw new Error("Enable a private writable workspace before starting a private brief.");
      }
      const path = ownBrief?.path || briefNotePath({ meetingId: meeting.id, nativeId: nid });
      const noteId = path.split("/").pop()!.replace(/\.md$/, "");
      const prompt = `Interview me to build the brief for ${JSON.stringify(name)} — ask what you can't know from my records (who's in the room, what I want out of it, what the notetaker should listen for). Write the brief at relative path ${JSON.stringify(path)} (full mount path ${JSON.stringify(`${mount.path}/${path}`)}) in my PRIVATE workspace ${JSON.stringify(mount.slug)}. Do not write this private brief into any shared workspace. For a NEW file use frontmatter type: meeting, id: ${JSON.stringify(noteId)}, title: ${JSON.stringify(name)}, and meeting_id: ${meeting.id}. Read the existing file first and preserve user edits and frontmatter; continue it rather than replacing it. Write the note EARLY and fold every detail I provide immediately into the file — do not leave empty placeholder sections or block on web search.`;
      if (mountedRef.current) setBriefChatStarted(true);
      await sendBriefPrompt(prompt, {
        displayText: ownBrief ? `Update brief for “${name}”` : `Start brief interview for “${name}”`,
      });
    } catch (e) {
      if (mountedRef.current) setErr(presentError(e).headline);
    } finally {
      if (mountedRef.current) setBusyAction(false);
    }
  }, [chatBusy, headline, meeting.id, meeting.native_id, meetingsOnly, ownBrief, readOnly, sendBriefPrompt, title]);

  // Canonical Shared Workspace README brief
  const askForSharedBrief = useCallback(
    async (slug: string) => {
      if (meetingsOnly || chatBusy) return;
      const name = title.trim() || headline;
      const prompt = `Prepare the brief for "${name}" in the ${slug} workspace README — who's attending (research them in our records), what happened last time, open follow-ups, and a suggested agenda. Read and update the existing README, preserving user edits. Ask me what you can't know from records.`;
      setBriefChatStarted(true);
      await sendBriefPrompt(prompt, {
        displayText: sharedBriefText
          ? `Update team brief in ${shortWorkspaceLabel(slug)}`
          : `Draft team brief in ${shortWorkspaceLabel(slug)}`,
        workspaceOverride: slug,
      });
    },
    [chatBusy, headline, meetingsOnly, sendBriefPrompt, sharedBriefText, title],
  );

  // Create shared workspace + bind + scaffold team brief
  const createAndBind = async () => {
    if (meetingsOnly || readOnly || busyAction) return;
    setBusyAction(true);
    setErr(null);
    try {
      const name = (title.trim() || headline || "meeting-prep").slice(0, 60);
      const ws = await createSharedWorkspace(name);
      await updatePlannedMeeting(meeting.id, { workspace_id: ws.workspace_id });
      onUpdated();
      loadShares();
      notifyBriefChanged();
      emitWebToast(`Created shared workspace “${shortWorkspaceLabel(ws.workspace_id)}”`);
      const carry = ownBrief
        ? ` I already have a brief for this meeting in my own workspace at ${ownBrief.workspacePath}/${ownBrief.path} — carry its content over as the starting brief, then keep improving it.`
        : "";
      const prompt = `I just created the shared workspace "${ws.workspace_id}" for the meeting "${title.trim() || headline}" — it is brand-new (empty) and exists so the other participants and I can collaborate on this meeting and its series. Scaffold it now: write its README as the team brief (audience = everyone in the room, so keep my private context out unless I confirm it), set up whatever structure the series needs, and interview me for what you can't know from my records.${carry} Write early and keep updating as we talk — the README renders live on the meeting page.`;
      if (mountedRef.current) setBriefChatStarted(true);
      await sendBriefPrompt(prompt, {
        displayText: `Create & scaffold team brief in ${shortWorkspaceLabel(ws.workspace_id)}`,
        workspaceOverride: ws.workspace_id,
      });
    } catch (e) {
      if (mountedRef.current) setErr(presentError(e).headline);
    } finally {
      if (mountedRef.current) setBusyAction(false);
    }
  };

  // Auto-start brief interview when navigated via "Save & draft brief"
  useEffect(() => {
    if (!autoStartBrief || meetingsOnly || readOnly) return;
    onConsumeAutoStartBrief?.();
    if (meeting.workspace_id) {
      void askForSharedBrief(meeting.workspace_id);
    } else {
      void startBriefChat();
    }
  }, [autoStartBrief, meetingsOnly, readOnly, meeting.workspace_id, onConsumeAutoStartBrief, askForSharedBrief, startBriefChat]);

  const shareWorkspace = async () => {
    if (!meeting.workspace_id || busyAction) return;
    setBusyAction(true);
    setErr(null);
    try {
      const inv = await mintInvite({
        workspace_id: meeting.workspace_id,
        role: "contributor",
        mode: "open",
        expires_in_sec: 7 * 86400,
        max_uses: 50,
      });
      setInviteLink(`${window.location.origin}/?invite=${inv.token}`);
    } catch (e) {
      setErr(presentError(e).headline);
    } finally {
      setBusyAction(false);
    }
  };

  const sendBotNow = async () => {
    const parsed = parseMeetingInput(meetingUrl || meeting.native_id || "");
    const targetNativeId = parsed?.native_meeting_id || meeting.native_id;
    const targetPlatform = parsed?.platform || platformSlugFor(meeting.platform);
    if (!targetNativeId) {
      setErr("Add a valid Google Meet, Zoom, Teams, Jitsi, or Discord link first.");
      return;
    }
    setBusyAction(true);
    setErr(null);
    setDenial(null);
    try {
      const urlToSend = parsed
        ? meetingUrlFor(parsed, meetingUrl || meeting.native_id || "")
        : meeting.meeting_url || undefined;
      const r = await fetch("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          platform: targetPlatform,
          native_meeting_id: targetNativeId,
          ...(urlToSend ? { meeting_url: urlToSend } : {}),
          bot_name: defaultBotName(),
        }),
      });
      if (!r.ok) throw await readApiFailure(r, "/api/bots");
      const body = await r.json().catch(() => null);
      const targetId = seedLiveMeetingFromResponse(body);
      onUpdated();
      emitWebToast("TINA bot dispatched to meeting");
      if (targetId && targetId !== meeting.id) {
        onOpenMeeting?.(targetId);
      }
    } catch (e) {
      const state = resolveJoinError(e);
      if (state.kind === "denial") setDenial(state.presentation);
      else setErr(state.headline);
    } finally {
      if (mountedRef.current) setBusyAction(false);
    }
  };

  const deletePlan = async () => {
    if (readOnly || busyAction) return;
    if (typeof window !== "undefined" && !window.confirm("Delete this planned meeting?")) return;
    setBusyAction(true);
    setErr(null);
    try {
      await deletePlannedMeeting(meeting.id);
      writePlannedLiveAssistDraft(meeting.id, EMPTY_LIVE_ASSIST_DRAFT);
      refreshMeetings();
      notifyBriefChanged();
      onBack();
    } catch (e) {
      if (mountedRef.current) {
        setErr(presentError(e).headline);
        setBusyAction(false);
      }
    }
  };

  const submitBriefReply = useCallback(
    (rawInput: string) => {
      const userText = rawInput.trim();
      if (!userText || chatBusy) return;
      const name = title.trim() || headline;
      if (meeting.workspace_id) {
        const wirePrompt = [
          `Update the team brief at "README.md" in the shared workspace ${JSON.stringify(meeting.workspace_id)} immediately with ALL details I just provided below.`,
          `Read the existing README.md first, preserve team edits, and write/update the complete structured brief (Objective, Attendees, Agenda, Key Points, Action Items & Deadlines) right now — do NOT leave empty placeholder headings and do NOT block or wait on web search.`,
          `Reply in the exact language of my message below summarizing what you updated.`,
          "",
          BRIEF_REPLY_SENTINEL,
          userText,
        ].join("\n");
        void sendBriefPrompt(wirePrompt, { displayText: userText });
        return;
      }
      const targetPath = ownBrief?.path || briefNotePath({ meetingId: meeting.id, nativeId: meeting.native_id });
      const targetSlug = ownBrief?.slug || "personal";
      const noteId = targetPath.split("/").pop()!.replace(/\.md$/, "");
      const wirePrompt = [
        `Update the meeting brief at ${JSON.stringify(targetPath)} in my private workspace ${JSON.stringify(targetSlug)} immediately with ALL details I just provided below.`,
        `Read the existing file first (or create it with YAML frontmatter type: meeting, id: ${JSON.stringify(noteId)}, title: ${JSON.stringify(name)}, meeting_id: ${meeting.id} if missing), keep valid frontmatter, and write/update the complete structured brief (Objective, Attendees, Agenda, Key Points to Listen For, Deadlines & Specific Tasks) right now — do NOT leave empty placeholder headings and do NOT block or wait on web search.`,
        `Reply in the exact language of my message below summarizing what you updated.`,
        "",
        BRIEF_REPLY_SENTINEL,
        userText,
      ].join("\n");
      setBriefChatStarted(true);
      void sendBriefPrompt(wirePrompt, { displayText: userText });
    },
    [chatBusy, headline, meeting.id, meeting.native_id, meeting.workspace_id, ownBrief, sendBriefPrompt, title],
  );

  const handleChatSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitBriefReply(draft);
  };

  const copyMessage = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedMsgId(id);
      emitWebToast("Copied response to clipboard");
      window.setTimeout(() => setCopiedMsgId((cur) => (cur === id ? null : cur)), 1800);
    } catch {
      /* ignore clipboard error */
    }
  };

  const copyInvite = async () => {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      setCopiedInvite(true);
      emitWebToast("Workspace invite link copied");
      window.setTimeout(() => setCopiedInvite(false), 1800);
    } catch {
      /* ignore clipboard error */
    }
  };

  const parsedLink = useMemo(() => parseMeetingInput(meetingUrl), [meetingUrl]);
  const hasDetectedLink = !!(meeting.native_id || parsedLink);
  const ensureRow = useCallback(async () => meeting.id, [meeting.id]);

  return (
    <div
      className={`${styles.shell} ${meetingsOnly ? styles.shellSingle : ""}`}
      data-testid="meeting-prep-workspace"
    >
      {/* ── Left / Main Prep Stage ────────────────────────────────────────── */}
      <div className={styles.mainScroll}>
        <PlannedLiveAssistProvider
          meetingId={meeting.id}
          draftKey={meeting.id}
          readOnly={readOnly}
          ensureRow={ensureRow}
        >
          <div className={styles.mainInner}>
            {/* 1. Subject & Save Status */}
            <section className={styles.subjectCard}>
              <div className={styles.eyebrowRow}>
                <span className={styles.eyebrow}>
                  <WebIcon name="calendarCheck" size={13} />
                  <span>Pre-meeting Brief Studio</span>
                </span>
                <span
                  className={`${styles.saveIndicator} ${savedNotice ? styles.saveIndicatorSaved : ""}`}
                  role="status"
                >
                  {savingField ? "Saving…" : savedNotice ? "Saved" : meeting.platform}
                </span>
              </div>

              {readOnly ? (
                <h1 className={styles.titleReadonly}>{headline}</h1>
              ) : (
                <input
                  type="text"
                  className={styles.titleInput}
                  aria-label="Meeting title"
                  placeholder="What is this meeting about?"
                  value={title}
                  disabled={busyAction}
                  onChange={(e) => setTitle(e.target.value)}
                  onBlur={() => {
                    const next = title.trim();
                    if ((meeting.title_custom ?? meeting.title ?? "") !== next) {
                      void patchMeeting({ title: next || null });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />
              )}
            </section>

            {meeting.auto_join_error && (
              <div className={styles.errorAlert} role="alert">
                <WebIcon name="alertTriangle" size={15} />
                <span>Auto-join failed: {meeting.auto_join_error}</span>
              </div>
            )}

            {/* 2. Meeting Link & Schedule Setup */}
            <div className={styles.setupGrid}>
              <section className={styles.setupCard}>
                <div className={styles.setupHead}>
                  <label className={styles.setupLabel} htmlFor={`prep-link-${meeting.id}`}>
                    <WebIcon name="link" size={13} />
                    <span>Meeting link</span>
                  </label>
                  {hasDetectedLink && (
                    <span className={styles.detectedPill}>
                      <WebIcon name="check" size={11} />
                      <span>Detected</span>
                    </span>
                  )}
                </div>

                <input
                  id={`prep-link-${meeting.id}`}
                  type="url"
                  className={styles.fieldInput}
                  value={meetingUrl}
                  disabled={readOnly || busyAction}
                  placeholder="https://meet.google.com/abc-defg-hij"
                  onChange={(e) => setMeetingUrl(e.target.value)}
                  onBlur={() => {
                    const next = meetingUrl.trim();
                    if ((meeting.meeting_url ?? "") !== next) {
                      void patchMeeting({ meeting_url: next || null });
                    }
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                />

                <div className={styles.setupFoot}>
                  {!readOnly && (
                    <label className={styles.autoJoinLabel}>
                      <input
                        type="checkbox"
                        checked={autoJoin}
                        disabled={busyAction}
                        onChange={(e) => {
                          const checked = e.target.checked;
                          setAutoJoin(checked);
                          void patchMeeting({ auto_join: checked });
                        }}
                      />
                      <span>Auto-join</span>
                      {!hasDetectedLink && <span className={styles.helperMuted}>(needs a link)</span>}
                    </label>
                  )}
                  {meeting.meeting_url && (
                    <a
                      className={styles.inlineLink}
                      href={meeting.meeting_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <span>Open link</span>
                      <WebIcon name="externalLink" size={12} />
                    </a>
                  )}
                </div>
              </section>

              <section className={styles.setupCard}>
                <div className={styles.setupHead}>
                  <label className={styles.setupLabel} htmlFor={`prep-time-${meeting.id}`}>
                    <WebIcon name="clock" size={13} />
                    <span>Scheduled time</span>
                  </label>
                  <span
                    className={`${styles.schedulePill} ${scheduledAt ? styles.schedulePillActive : ""}`}
                  >
                    {scheduledAt ? "Scheduled" : "Immediate join"}
                  </span>
                </div>

                <DateTimePicker
                  id={`prep-time-${meeting.id}`}
                  value={scheduledAt}
                  disabled={readOnly || busyAction}
                  onChange={(iso) => {
                    setScheduledAt(iso);
                    void patchMeeting({ scheduled_at: iso });
                  }}
                />

                <div className={styles.setupFoot}>
                  <span>
                    {scheduledAt
                      ? "Auto-joins when meeting starts"
                      : "No schedule set. Send bot whenever ready."}
                  </span>
                  {!readOnly && scheduledAt && (
                    <button
                      type="button"
                      className={styles.clearTimeBtn}
                      onClick={() => {
                        setScheduledAt("");
                        void patchMeeting({ scheduled_at: null });
                      }}
                    >
                      Clear
                    </button>
                  )}
                </div>
              </section>
            </div>

            {/* 3. Attendees Strip */}
            {(meeting.attendees?.length ?? 0) > 0 && (
              <section className={styles.attendeesBlock} aria-label="Attendees">
                <span className={styles.setupLabel}>
                  <WebIcon name="users" size={13} />
                  <span>Attendees ({meeting.attendees!.length})</span>
                </span>
                <div className={styles.attendeesList}>
                  {meeting.attendees!.map((a) => {
                    const display = a.name || a.email;
                    const initials = (
                      a.name
                        ? a.name
                            .split(/\s+/)
                            .map((w) => w[0])
                            .slice(0, 2)
                            .join("")
                        : a.email.slice(0, 2)
                    ).toUpperCase();
                    const declined = a.partstat === "declined";
                    return (
                      <span
                        key={a.email}
                        title={a.email + (a.partstat ? ` (${a.partstat})` : "")}
                        className={`${styles.attendeeChip} ${declined ? styles.attendeeDeclined : ""}`}
                      >
                        <span className={styles.attendeeInitials}>{initials}</span>
                        <span>{display}</span>
                      </span>
                    );
                  })}
                </div>
              </section>
            )}

            {/* 4. Workspace & Actions Bar */}
            <div className={styles.workspaceBar}>
              <div className={styles.workspaceInfo}>
                <span className={styles.workspaceTag}>Workspace</span>
                {meeting.workspace_id ? (
                  <>
                    <span
                      className={`${styles.workspaceValue} ${styles.workspaceValueShared}`}
                      title={meeting.workspace_id}
                    >
                      <span className={styles.workspaceDot} aria-hidden="true" />
                      <span>{shortWorkspaceLabel(meeting.workspace_id)}</span>
                    </span>
                    {!readOnly && !meetingsOnly && shares.length > 0 && (
                      <button
                        type="button"
                        className={styles.btnGhost}
                        onClick={() => setRebindOpen((v) => !v)}
                      >
                        Change
                      </button>
                    )}
                  </>
                ) : (
                  <span className={styles.workspaceValue}>My Space · Private</span>
                )}
                {readOnly && <span className={styles.schedulePill}>Shared with you</span>}
              </div>

              <div className={styles.utilityActions}>
                {!readOnly && !meetingsOnly && meeting.workspace_id && (
                  <button
                    type="button"
                    className={styles.btnGhost}
                    disabled={busyAction}
                    onClick={() => void shareWorkspace()}
                  >
                    <WebIcon name="share" size={13} />
                    <span>
                      Share with attendees
                      {(meeting.attendees?.length ?? 0) > 0 ? ` (${meeting.attendees!.length})` : ""}
                    </span>
                  </button>
                )}

                {!readOnly && (
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    disabled={busyAction || !hasDetectedLink}
                    title={hasDetectedLink ? "Send TINA bot now" : "Add a valid meeting link first"}
                    onClick={() => void sendBotNow()}
                  >
                    <WebIcon name="play" size={13} />
                    <span>Send bot now</span>
                  </button>
                )}

                {!readOnly && (
                  <button
                    type="button"
                    className={styles.btnGhost}
                    aria-label="More meeting actions"
                    aria-expanded={moreOpen}
                    onClick={() => setMoreOpen((v) => !v)}
                  >
                    <WebIcon name="moreHorizontal" size={15} />
                  </button>
                )}
              </div>
            </div>

            {rebindOpen && !readOnly && !meetingsOnly && shares.length > 0 && (
              <div className={styles.subRow}>
                <select
                  aria-label="Bind a different workspace"
                  defaultValue=""
                  disabled={busyAction}
                  className={styles.selectInput}
                  onChange={(e) => {
                    if (e.target.value) {
                      void patchMeeting({ workspace_id: e.target.value });
                      setRebindOpen(false);
                      notifyBriefChanged();
                    }
                  }}
                >
                  <option value="" disabled>
                    Bind a different workspace…
                  </option>
                  {shares.map((s) => (
                    <option key={s.workspace_id} value={s.workspace_id}>
                      {shortWorkspaceLabel(s.workspace_id)}
                    </option>
                  ))}
                </select>
                <button type="button" className={styles.btnGhost} onClick={() => setRebindOpen(false)}>
                  Cancel
                </button>
              </div>
            )}

            {moreOpen && !readOnly && (
              <div className={styles.subRow}>
                {meeting.workspace_id && (
                  <button
                    type="button"
                    className={styles.btnGhost}
                    disabled={busyAction}
                    onClick={() => {
                      void patchMeeting({ workspace_id: null });
                      setMoreOpen(false);
                      notifyBriefChanged();
                    }}
                  >
                    Unbind shared workspace
                  </button>
                )}
                <button
                  type="button"
                  className={`${styles.btnGhost} ${styles.btnDanger}`}
                  disabled={busyAction}
                  onClick={() => void deletePlan()}
                >
                  <WebIcon name="trash" size={13} />
                  <span>Delete meeting plan</span>
                </button>
              </div>
            )}

            {inviteLink && (
              <div className={styles.subRow}>
                <input
                  readOnly
                  aria-label="Workspace invite link"
                  value={inviteLink}
                  className={styles.inviteInput}
                  onFocus={(e) => e.currentTarget.select()}
                />
                <button type="button" className={styles.btnPrimary} onClick={() => void copyInvite()}>
                  <WebIcon name={copiedInvite ? "check" : "copy"} size={13} />
                  <span>{copiedInvite ? "Copied" : "Copy invite"}</span>
                </button>
              </div>
            )}

            {/* 5. HERO BRIEF STAGE */}
            {!meetingsOnly && (
              <section
                className={`${styles.briefStage} ${
                  (!meeting.workspace_id && !ownBrief) || (meeting.workspace_id && !sharedBriefText)
                    ? styles.briefStageEmpty
                    : ""
                }`}
                aria-label="Meeting brief"
                data-testid="meeting-brief-stage"
              >
                {meeting.workspace_id ? (
                  sharedBriefState === "loading" && !sharedBriefText ? (
                    <div className={styles.briefProgressBanner}>
                      <div className={styles.briefProgressLeft}>
                        <span className={styles.pulseDot} aria-hidden="true" />
                        <span className={styles.briefLead}>Checking team brief in workspace README…</span>
                      </div>
                    </div>
                  ) : sharedBriefText ? (
                    <>
                      <div className={styles.briefDocHead}>
                        <span className={styles.briefDocSource}>
                          <WebIcon name="bookOpen" size={14} />
                          <span>Team brief</span>
                          <span className={styles.briefDocMeta}>
                            · {shortWorkspaceLabel(meeting.workspace_id)} / README.md
                          </span>
                        </span>
                        <div className={styles.briefDocActions}>
                          <button
                            type="button"
                            className={styles.btnGhost}
                            title="Refresh brief"
                            aria-label="Refresh brief"
                            onClick={() => scheduleBriefRefresh(true)}
                          >
                            <WebIcon name="refresh" size={13} />
                          </button>
                          {onOpenKnowledgeDoc && (
                            <button
                              type="button"
                              className={styles.btnGhost}
                              onClick={() => onOpenKnowledgeDoc("README.md", meeting.workspace_id!)}
                            >
                              <WebIcon name="externalLink" size={13} />
                              <span>Open in Knowledge</span>
                            </button>
                          )}
                          <button
                            type="button"
                            className={styles.btnPrimary}
                            disabled={chatBusy}
                            onClick={() => void askForSharedBrief(meeting.workspace_id!)}
                          >
                            <WebIcon name="sparkleSmall" size={13} />
                            <span>Update via chat</span>
                          </button>
                        </div>
                      </div>
                      <div className={styles.briefDocBody}>
                        <Markdown>{stripYamlFrontmatter(sharedBriefText)}</Markdown>
                      </div>
                    </>
                  ) : (
                    <div className={styles.briefEmptyInner}>
                      <div className={styles.briefEmptyHead}>
                        <span className={styles.briefBadgeIcon} aria-hidden="true">
                          <WebIcon name="fileText" size={18} />
                        </span>
                        <div className={styles.briefEmptyCopy}>
                          <h2 className={styles.briefTitle}>No brief yet</h2>
                          <p className={styles.briefLead}>
                            Draft a team-facing brief in{" "}
                            <strong>{shortWorkspaceLabel(meeting.workspace_id)}</strong> with attendee
                            context, previous notes, open follow-ups, and a suggested agenda.
                          </p>
                        </div>
                      </div>
                      <div className={styles.briefActions}>
                        <button
                          type="button"
                          className={styles.btnPrimary}
                          disabled={busyAction || chatBusy}
                          onClick={() => void askForSharedBrief(meeting.workspace_id!)}
                        >
                          <WebIcon name="sparkleSmall" size={14} />
                          <span>Draft the brief</span>
                        </button>
                        <button
                          type="button"
                          className={styles.btnGhost}
                          onClick={() => scheduleBriefRefresh(true)}
                        >
                          <WebIcon name="refresh" size={13} />
                          <span>Check again</span>
                        </button>
                      </div>
                    </div>
                  )
                ) : readOnly ? (
                  <div className={styles.briefEmptyInner}>
                    <p className={styles.briefLead}>No shared workspace is bound to this meeting yet.</p>
                  </div>
                ) : ownBrief ? (
                  <>
                    <div className={styles.briefDocHead}>
                      <span className={styles.briefDocSource} title={ownBrief.path}>
                        <WebIcon name="fileText" size={14} />
                        <span>Your brief for this meeting</span>
                        <span className={styles.briefDocMeta}>· My Space</span>
                      </span>
                      <div className={styles.briefDocActions}>
                        <button
                          type="button"
                          className={styles.btnGhost}
                          title="Refresh brief"
                          aria-label="Refresh brief"
                          onClick={() => scheduleBriefRefresh(true)}
                        >
                          <WebIcon name="refresh" size={13} />
                        </button>
                        {onOpenKnowledgeDoc && (
                          <button
                            type="button"
                            className={styles.btnGhost}
                            onClick={() => onOpenKnowledgeDoc(ownBrief.path, ownBrief.slug)}
                          >
                            <WebIcon name="externalLink" size={13} />
                            <span>Open in Knowledge</span>
                          </button>
                        )}
                        <button
                          type="button"
                          className={styles.btnPrimary}
                          disabled={chatBusy}
                          onClick={() => void startBriefChat()}
                        >
                          <WebIcon name="sparkleSmall" size={13} />
                          <span>Update via chat</span>
                        </button>
                      </div>
                    </div>
                    <div className={styles.briefDocBody}>
                      <Markdown>{stripYamlFrontmatter(ownBrief.text)}</Markdown>
                    </div>
                  </>
                ) : briefChatStarted || chatBusy ? (
                  <div className={styles.briefProgressBanner} role="status">
                    <div className={styles.briefProgressLeft}>
                      <span className={styles.pulseDot} aria-hidden="true" />
                      <div className={styles.briefEmptyCopy}>
                        <strong style={{ fontSize: 14 }}>Brief interview in progress</strong>
                        <span className={styles.briefLead}>
                          Your brief renders live here as soon as TINA writes it in your workspace.
                        </span>
                      </div>
                    </div>
                    <div className={styles.briefActions}>
                      <button
                        type="button"
                        className={styles.btnGhost}
                        onClick={() => scheduleBriefRefresh(true)}
                      >
                        <WebIcon name="refresh" size={13} />
                        <span>Check now</span>
                      </button>
                      <button
                        type="button"
                        className={styles.btnGhost}
                        disabled={busyAction || chatBusy}
                        onClick={() => void createAndBind()}
                      >
                        Create shared workspace
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className={styles.briefEmptyInner}>
                    <div className={styles.briefEmptyHead}>
                      <span className={styles.briefBadgeIcon} aria-hidden="true">
                        <WebIcon name="sparkleSmall" size={18} />
                      </span>
                      <div className={styles.briefEmptyCopy}>
                        <h2 className={styles.briefTitle}>
                          {ownBriefLoading ? "Checking brief…" : "No brief yet"}
                        </h2>
                        <p className={styles.briefLead}>
                          A brief helps TINA prepare: who&rsquo;s in the room, what you want from the
                          meeting, and what the notetaker should listen for.
                        </p>
                      </div>
                    </div>

                    <div className={styles.briefModes}>
                      <div className={styles.briefModeCard}>
                        <strong>Brief chat (Private)</strong>
                        Interviews you on the right and saves the brief in your own workspace, reused
                        across recurring calls.
                      </div>
                      <div className={styles.briefModeCard}>
                        <strong>Shared workspace (Team)</strong>
                        Creates a shared space so invited attendees can read the brief and live
                        transcript together.
                      </div>
                    </div>

                    <div className={styles.briefActions}>
                      <button
                        type="button"
                        className={styles.btnPrimary}
                        disabled={busyAction || chatBusy}
                        onClick={() => void startBriefChat()}
                      >
                        <WebIcon name="tinaAsk" size={14} />
                        <span>Start brief chat</span>
                      </button>
                      <button
                        type="button"
                        className={styles.btnGhost}
                        disabled={busyAction || chatBusy}
                        onClick={() => void createAndBind()}
                      >
                        <WebIcon name="users" size={14} />
                        <span>Create shared workspace</span>
                      </button>
                      {shares.length > 0 && (
                        <select
                          aria-label="Bind an existing workspace"
                          defaultValue=""
                          disabled={busyAction}
                          className={styles.selectInput}
                          onChange={(e) => {
                            if (e.target.value) {
                              void patchMeeting({ workspace_id: e.target.value });
                              notifyBriefChanged();
                            }
                          }}
                        >
                          <option value="" disabled>
                            Bind an existing workspace…
                          </option>
                          {shares.map((s) => (
                            <option key={s.workspace_id} value={s.workspace_id}>
                              {shortWorkspaceLabel(s.workspace_id)}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  </div>
                )}
              </section>
            )}

            {/* 6. Live Assist Goal & Draft Agenda */}
            <section className={styles.planCard} aria-label="Meeting goal and draft agenda">
              <div className={styles.planCardHead}>
                <h2 className={styles.planCardTitle}>Meeting Goal &amp; Agenda</h2>
                <span className={styles.planCardSub}>Synced to Live Assist when the call begins</span>
              </div>
              <PlannedLiveAssistGoal />
              <PlannedLiveAssistAgenda />
            </section>

            {denial && <ServiceDenialPanel presentation={denial} onRetry={() => void sendBotNow()} />}
            {err && (
              <div className={styles.errorAlert} role="alert">
                <WebIcon name="alertTriangle" size={15} />
                <span>{err}</span>
              </div>
            )}
            {briefError && (
              <div className={styles.errorAlert} role="alert">
                <WebIcon name="alertTriangle" size={15} />
                <span>{briefError}</span>
              </div>
            )}
          </div>
        </PlannedLiveAssistProvider>
      </div>

      {/* ── Right Rail: Live Brief Assistant Chat ─────────────────────────── */}
      {!meetingsOnly && (
        <aside className={styles.chatRail} aria-label="Brief Assistant chat">
          <div className={styles.chatHead}>
            <div className={styles.chatHeadTitle}>
              <span className={styles.tinaOrb} aria-hidden="true">
                <WebIcon name="tinaAsk" size={13} />
              </span>
              <div className={styles.chatHeadText}>
                <strong>Brief Assistant</strong>
                <span>
                  {meeting.workspace_id
                    ? `Team brief · ${shortWorkspaceLabel(meeting.workspace_id)}`
                    : "Private brief · My Space"}
                </span>
              </div>
            </div>
            {(ownBrief || sharedBriefText) && (
              <span className={styles.detectedPill}>
                <WebIcon name="check" size={11} />
                <span>Brief ready</span>
              </span>
            )}
          </div>

          <div className={styles.chatBody}>
            {messages.length === 0 ? (
              <div className={styles.chatHero}>
                <span className={styles.chatHeroIcon} aria-hidden="true">
                  <WebIcon name="sparkleSmall" size={20} />
                </span>
                <h3>Prep with TINA, {firstName}</h3>
                <p>
                  Answer a few quick questions and watch your meeting brief appear live on the left.
                </p>
                <div className={styles.starterList}>
                  <button
                    type="button"
                    className={`${styles.starterBtn} ${styles.starterBtnPrimary}`}
                    disabled={busyAction || chatBusy || readOnly}
                    onClick={() =>
                      meeting.workspace_id
                        ? void askForSharedBrief(meeting.workspace_id)
                        : void startBriefChat()
                    }
                  >
                    <WebIcon name="tinaAsk" size={14} />
                    <span>
                      {meeting.workspace_id
                        ? sharedBriefText
                          ? "Update the team brief"
                          : "Draft the team brief"
                        : ownBrief
                          ? "Update this brief"
                          : "Start brief interview"}
                    </span>
                  </button>
                  <button
                    type="button"
                    className={styles.starterBtn}
                    disabled={chatBusy}
                    onClick={() =>
                      void sendBriefPrompt(
                        `Research the attendees and prior context in my knowledge base for "${headline}" and summarize what I should know before the meeting.`,
                        { displayText: "Research attendees & past context" },
                      )
                    }
                  >
                    <WebIcon name="users" size={14} />
                    <span>Research attendees &amp; past context</span>
                  </button>
                  <button
                    type="button"
                    className={styles.starterBtn}
                    disabled={chatBusy}
                    onClick={() =>
                      void sendBriefPrompt(
                        `Suggest a focused 30-minute agenda and 3 key questions for "${headline}".`,
                        { displayText: "Suggest a focused agenda" },
                      )
                    }
                  >
                    <WebIcon name="listChecks" size={14} />
                    <span>Suggest a focused agenda</span>
                  </button>
                </div>
              </div>
            ) : (
              messages.map((msg, idx) => {
                const isStreamingThis = chatBusy && msg.role === "agent" && idx === messages.length - 1;
                const retryPrev = () => {
                  if (chatBusy) return;
                  for (let i = idx - 1; i >= 0; i--) {
                    const prev = messages[i];
                    if (prev?.role === "user") {
                      void sendBriefPrompt(prev.text, { displayText: prev.displayText });
                      return;
                    }
                  }
                };

                if (msg.role === "user") {
                  return (
                    <div key={msg.id} className={`${styles.chatBubble} ${styles.chatBubbleUser}`}>
                      {msg.displayText || msg.text}
                    </div>
                  );
                }

                return (
                  <div key={msg.id} className={`${styles.chatBubble} ${styles.chatBubbleAgent}`}>
                    <div className={styles.bubbleHead}>
                      <span className={styles.tinaOrb} aria-hidden="true" style={{ width: 18, height: 18 }}>
                        <WebIcon name="tinaAsk" size={10} />
                      </span>
                      <span>Tina AI</span>
                      {msg.commit && (
                        <span className={styles.commitPill}>
                          <WebIcon name="check" size={10} />
                          <span>Brief updated</span>
                        </span>
                      )}
                    </div>

                    {msg.ops && msg.ops.length > 0 && (
                      <AgentActivitySteps ops={msg.ops} streaming={isStreamingThis && !msg.text} compact />
                    )}

                    {msg.approvals && msg.approvals.length > 0 && (
                      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                        {msg.approvals.map((approval) => (
                          <LucianToolApprovalCard
                            key={approval.approval_id}
                            approval={approval}
                            onDecision={(id, decision) => void respondToApproval(id, decision)}
                          />
                        ))}
                      </div>
                    )}

                    {msg.error ? (
                      <div className={styles.errorAlert} role="alert" style={{ padding: "8px 10px" }}>
                        <WebIcon name="alertTriangle" size={14} />
                        <span style={{ flex: 1 }}>{msg.error}</span>
                        {!chatBusy && (
                          <button type="button" className={styles.btnGhost} onClick={retryPrev}>
                            Retry
                          </button>
                        )}
                      </div>
                    ) : msg.text ? (
                      <div className={styles.bubbleProse}>
                        <Markdown>{msg.text}</Markdown>
                      </div>
                    ) : !(msg.ops && msg.ops.length > 0) ? (
                      <LucianThinkingText
                        compact
                        label={
                          chatPhase === "reconnecting"
                            ? "Reconnecting…"
                            : chatPhase === "stalled"
                              ? "Still working…"
                              : chatPhase === "connecting"
                                ? "Reading meeting context…"
                                : "Drafting brief…"
                        }
                        lines={[
                          `Preparing brief for ${headline}`,
                          "Checking past meetings, people & workspace notes",
                        ]}
                      />
                    ) : null}

                    {msg.text && !isStreamingThis && (
                      <div className={styles.bubbleFooter}>
                        <button
                          type="button"
                          className={styles.bubbleActionBtn}
                          onClick={() => void copyMessage(msg.id, msg.text)}
                        >
                          <WebIcon name={copiedMsgId === msg.id ? "check" : "copy"} size={12} />
                          <span>{copiedMsgId === msg.id ? "Copied" : "Copy"}</span>
                        </button>
                        <button
                          type="button"
                          className={styles.bubbleActionBtn}
                          disabled={chatBusy}
                          onClick={retryPrev}
                        >
                          <WebIcon name="refresh" size={12} />
                          <span>Retry</span>
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            )}
            <div ref={chatEndRef} />
          </div>

          <div className={styles.chatFoot}>
            <form className={styles.composer} onSubmit={handleChatSubmit}>
              <textarea
                ref={composerRef}
                rows={1}
                value={draft}
                disabled={chatBusy}
                aria-label="Reply to Brief Assistant"
                placeholder="Share goals, attendees, or edits for the brief…"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submitBriefReply(draft);
                  }
                }}
              />
              {chatBusy ? (
                <button
                  type="button"
                  className={styles.stopBtn}
                  aria-label="Stop generating"
                  onClick={() => abortRef.current?.abort()}
                >
                  <WebIcon name="stop" size={11} />
                  <span>Stop</span>
                </button>
              ) : (
                <button
                  type="submit"
                  className={styles.sendBtn}
                  disabled={!draft.trim()}
                  aria-label="Send message to Brief Assistant"
                >
                  <WebIcon name="sendUp" size={14} />
                </button>
              )}
            </form>
          </div>
        </aside>
      )}
    </div>
  );
}
