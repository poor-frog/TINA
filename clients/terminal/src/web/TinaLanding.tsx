"use client";
/** TinaLanding — Editorial Neo-Brutalist pre-login landing & OAuth gate for TINA Terminal.
 *  Inspired by the warm-paper / ink-stamp / acid-lime visual system, fully tailored to
 *  TINA's real self-hosted capabilities (Google/Microsoft OAuth, first-run admin claim,
 *  bilingual VI+EN transcription, "Tina ơi" Voice TTS, Chrome Extension, and Workspace). */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { HeroMeetingScene } from "./HeroMeetingScene";
import styles from "./tinaLanding.module.css";

export interface TinaLandingProps {
  claiming: boolean;
  providers: { google: boolean; microsoft: boolean };
  directLoginAvailable: boolean;
  showDebug: boolean;
  onToggleDebug: () => void;
  email: string;
  onEmailChange: (value: string) => void;
  submitting: boolean;
  error: string | null;
  onDirectSubmit: (e: FormEvent) => void;
  onOAuthSignIn: (provider: "google" | "microsoft") => void;
  googleIcon: ReactNode;
  microsoftIcon: ReactNode;
}

const TICKER_ITEMS = [
  "GOOGLE MEET",
  "ZOOM",
  "MICROSOFT TEAMS",
  "BILINGUAL VI + EN",
  "TINA VOICE AGENT",
  "GROUNDED WIKI & NOTES",
  "CHROME EXTENSION",
  "SELF-HOSTED PRIVACY",
];

const DEMO_LINES = [
  {
    initials: "JL",
    speaker: "JKY LEE",
    time: "09:40:43",
    primary: "Chốt lại tiến độ triển khai AWS staging và Chrome Extension tuần này nhé.",
    secondary: "Let’s finalize this week’s AWS staging and Chrome Extension rollout.",
    isAgent: false,
  },
  {
    initials: "LH",
    speaker: "Linh",
    time: "09:41:02",
    primary: "11 stack ECS Fargate đã chạy ổn định trên us-east-1, còn phần custom domain với Multi-AZ cho production.",
    secondary: "All 11 ECS Fargate stacks are healthy in us-east-1; custom domain and Multi-AZ remain for production.",
    isAgent: false,
  },
  {
    initials: "TA",
    speaker: "TINA Agent",
    badge: "Đã đọc · Nguồn meeting",
    time: "09:41:15",
    primary: "TINA đã tổng hợp 2 việc cần làm: gắn custom domain + ACM cho production và cập nhật Extension ID vào allowlist Gateway.",
    secondary: "Nguồn (2) · Trích dẫn trực tiếp từ đoạn 09:40:43 & 09:41:02",
    isAgent: true,
  },
  {
    initials: "MN",
    speaker: "Minh",
    time: "09:41:28",
    primary: "Chuẩn luôn, lưu thẳng vào Wiki dự án giúp mình nhé.",
    secondary: "Looks great — save that directly into the project Wiki.",
    isAgent: false,
  },
];

const CAPABILITIES_LISTEN = [
  { label: "BILINGUAL ASR", text: "Live Vietnamese & English capture via VieGem + LM, Whisper, Soniox, or Deepgram." },
  { label: "SPEAKER TALK TIME", text: "Per-speaker word counts, speaking pace (WPM), share rings, and click-to-filter transcripts." },
  { label: "LIVE ASSIST", text: "Real-time structured notes, decisions, and action items tied to exact transcript quotes." },
  { label: "SYNCED AUDIO", text: "Durable recordings in your private S3 / MinIO bucket with click-to-seek playback." },
];

const CAPABILITIES_ACT = [
  { label: "VOICE ANSWERS", text: "Say “Tina ơi…” in Google Meet for spoken, transcript-grounded answers via VieNeu TTS." },
  { label: "ASK TINA + MCP", text: "Grounded Q&A across meetings and workspace docs with explicit tool-call approvals." },
  { label: "SHARED WIKI", text: "Save verified answers and meeting recaps directly into personal or team workspaces." },
  { label: "ROUTINES", text: "Run scheduled meeting summaries, recurring digests, and follow-up workflows automatically." },
];

const FAQ_ITEMS = [
  {
    q: "How do I sign in to TINA?",
    a: "Sign in with your Google or Microsoft account configured on this instance. On a fresh installation with no administrator yet, the very first sign-in automatically claims administrator access.",
  },
  {
    q: "Which meeting platforms are supported?",
    a: "TINA Bot joins Google Meet, Zoom, and Microsoft Teams from a link or connected calendar. On Google Meet, the TINA Chrome Extension also adds an in-call floating panel with live bilingual transcripts and Ask TINA.",
  },
  {
    q: "How does the “Tina ơi” voice agent work?",
    a: "When voice replies are enabled for a meeting, TINA listens for the wake word, answers out loud through VieNeu TTS and LiveKit using only confirmed transcript and workspace sources, and logs clickable citations right inside the transcript.",
  },
  {
    q: "Which AI models and transcription backends can I use?",
    a: "Connect ChatGPT Plan (OAuth), Claude, OpenAI API, Google Gemini, Groq, DeepSeek, AWS Bedrock, or any OpenAI-compatible gateway — paired with VieGem + LM, Whisper, Soniox, or Deepgram speech-to-text.",
  },
  {
    q: "Where do my recordings, transcripts, and keys live?",
    a: "Everything runs on your own Docker Compose or AWS ECS/Fargate infrastructure. Recordings stay in your private S3/MinIO bucket, transcripts stay in PostgreSQL, and all provider credentials remain strictly server-side.",
  },
  {
    q: "What is the difference between TINA Workspace and TINA Terminal?",
    a: "Everyone gets the clean Meetings, Ask Tina, Routines, and Settings workspace at /. Instance administrators can also switch into the full developer workbench at /terminal.",
  },
];

const WAKE_PROMPT = "Tina ơi, tổng hợp 2 quyết định chính của cuộc họp này";

export function TinaLanding({
  claiming,
  providers,
  directLoginAvailable,
  showDebug,
  onToggleDebug,
  email,
  onEmailChange,
  submitting,
  error,
  onDirectSubmit,
  onOAuthSignIn,
  googleIcon,
  microsoftIcon,
}: TinaLandingProps) {
  const [scrolled, setScrolled] = useState(false);
  const [scrollPct, setScrollPct] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeLine, setActiveLine] = useState(2);
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [copiedPrompt, setCopiedPrompt] = useState(false);

  const hasOAuth = providers.google || providers.microsoft;

  useEffect(() => {
    const onScroll = () => {
      const y = window.scrollY || 0;
      setScrolled(y > 12);
      const max = document.documentElement.scrollHeight - window.innerHeight;
      setScrollPct(max > 0 ? Math.min(100, (y / max) * 100) : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const timer = window.setInterval(() => {
      setActiveLine((cur) => (cur + 1) % DEMO_LINES.length);
    }, 3000);
    return () => window.clearInterval(timer);
  }, []);

  const triggerPrimarySignIn = () => {
    if (providers.google) {
      onOAuthSignIn("google");
      return;
    }
    if (providers.microsoft) {
      onOAuthSignIn("microsoft");
      return;
    }
    const el = document.getElementById("signin");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  const copyPrompt = async () => {
    try {
      await navigator.clipboard?.writeText(WAKE_PROMPT);
      setCopiedPrompt(true);
      window.setTimeout(() => setCopiedPrompt(false), 1800);
    } catch {
      setCopiedPrompt(false);
    }
  };

  return (
    <div className={styles.root}>
      <div className={styles.grain} aria-hidden="true" />
      <div className={styles.scrollBar} style={{ width: `${scrollPct}%` }} aria-hidden="true" />

      <header className={`${styles.navWrap} ${scrolled ? styles.navWrapScrolled : ""}`}>
        <div className={styles.container}>
          <nav className={styles.navRow} aria-label="Primary">
            <a className={styles.wordmark} href="#home-hero" aria-label="TINA home">
              <span className={styles.wordmarkBadge}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/tina-logo.svg" alt="" width={20} height={20} />
              </span>
              <span className={styles.wordmarkName}>TINA</span>
              <span className={styles.wordmarkTag}>MEETING AI</span>
            </a>

            <div className={styles.navLinks}>
              <a href="#how">How it works</a>
              <a href="#transcription">Live Voice</a>
              <a href="#modes">Modes</a>
              <a href="#capabilities">Capabilities</a>
              <a href="#privacy">Privacy</a>
              <a href="#platforms">Platforms</a>
              <a href="#faq">FAQ</a>
            </div>

            <div className={styles.navActions}>
              <a className={styles.navSecondary} href="#platforms">Self-hosted</a>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonDark}`}
                onClick={triggerPrimarySignIn}
              >
                <span>{claiming ? "Claim admin" : "Sign in"}</span>
                <span aria-hidden="true">→</span>
              </button>
              <button
                type="button"
                className={styles.navToggle}
                aria-label="Toggle navigation"
                aria-expanded={menuOpen}
                onClick={() => setMenuOpen((v) => !v)}
              >
                <span />
                <span />
                <span />
              </button>
            </div>
          </nav>
        </div>

        {menuOpen && (
          <nav className={styles.mobileMenu} aria-label="Mobile navigation">
            <a href="#how" onClick={() => setMenuOpen(false)}>How it works</a>
            <a href="#transcription" onClick={() => setMenuOpen(false)}>Live Voice &amp; Transcript</a>
            <a href="#modes" onClick={() => setMenuOpen(false)}>Modes</a>
            <a href="#capabilities" onClick={() => setMenuOpen(false)}>Capabilities</a>
            <a href="#privacy" onClick={() => setMenuOpen(false)}>Self-hosted privacy</a>
            <a href="#platforms" onClick={() => setMenuOpen(false)}>Platforms &amp; Models</a>
            <a href="#faq" onClick={() => setMenuOpen(false)}>FAQ</a>
          </nav>
        )}
      </header>

      <main className={styles.main}>
        {/* HERO + OAUTH SIGN-IN */}
        <section className={styles.homeHero} id="home-hero">
          <div className={styles.container}>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                {claiming ? (
                  <div className={styles.claimBadge}>
                    <span className={styles.claimDot} aria-hidden="true" />
                    <span>First sign-in = administrator</span>
                  </div>
                ) : (
                  <span className={styles.sectionLabel} style={{ marginBottom: 0, width: "fit-content" }}>
                    SELF-HOSTED · BILINGUAL VI + EN · LIVE VOICE AGENT
                  </span>
                )}

                <h1 className={styles.heroTitle}>
                  {claiming ? (
                    <>
                      Set up your instance
                    </>
                  ) : (
                    <>
                      Turn every<br />
                      <span className={styles.serif}>meeting</span> into a<br />
                      living <span className={styles.heroNoWrap}><span className={styles.heroAccent}>workspace</span>.</span>
                    </>
                  )}
                </h1>

                <p className={styles.heroLead}>
                  {claiming ? (
                    <>
                      This <strong>TINA</strong> instance has no administrator yet. Sign in to claim admin access and configure AI models, speech transcription, and teammates.
                    </>
                  ) : (
                    <>
                      <strong>TINA</strong> joins Google Meet, Zoom, and Microsoft Teams — streaming bilingual transcripts, answering out loud when you say <strong>“Tina ơi”</strong>, and turning every call into grounded notes and team memory.
                    </>
                  )}
                </p>

                <div className={styles.authBox} id="signin">
                  {claiming && !hasOAuth && directLoginAvailable && (
                    <div className={styles.notice}>
                      Development test mode — sign-in is limited to <strong>@example.test</strong> addresses. Add{" "}
                      <code>GOOGLE_CLIENT_ID</code>/<code>SECRET</code> or <code>MICROSOFT_CLIENT_ID</code>/<code>SECRET</code> for OAuth.
                    </div>
                  )}

                  {claiming && !hasOAuth && !directLoginAvailable && (
                    <div className={styles.notice}>
                      Configure Google or Microsoft OAuth to sign in. Passwordless test login is disabled outside development.
                    </div>
                  )}

                  {!claiming && !hasOAuth && !directLoginAvailable && (
                    <div className={styles.notice}>
                      No OAuth provider is configured on this TINA instance yet. Enable Google or Microsoft OAuth in your server environment.
                    </div>
                  )}

                  <div className={styles.heroActions}>
                    {providers.google && (
                      <button
                        type="button"
                        className={`${styles.button} ${styles.buttonLime} ${styles.oauthBtn}`}
                        onClick={() => onOAuthSignIn("google")}
                      >
                        {googleIcon}
                        <span>Continue with Google</span>
                        <span aria-hidden="true">→</span>
                      </button>
                    )}

                    {providers.microsoft && (
                      <button
                        type="button"
                        className={`${styles.button} ${styles.oauthBtn}`}
                        onClick={() => onOAuthSignIn("microsoft")}
                      >
                        {microsoftIcon}
                        <span>Continue with Microsoft</span>
                        <span aria-hidden="true">→</span>
                      </button>
                    )}

                    <a className={styles.buttonPlain} href="#how">
                      <span>How TINA works</span>
                      <span aria-hidden="true">↓</span>
                    </a>
                  </div>

                  {hasOAuth && directLoginAvailable && (
                    <button
                      type="button"
                      className={styles.debugToggle}
                      onClick={onToggleDebug}
                    >
                      {showDebug ? "Hide debug sign-in" : "Debug sign-in (@example.test)"}
                    </button>
                  )}

                  {directLoginAvailable && (!hasOAuth || showDebug) && (
                    <form className={styles.directForm} onSubmit={onDirectSubmit}>
                      <div className={styles.directHint}>
                        {claiming && !hasOAuth
                          ? "Email — use an @example.test address (development only)."
                          : "Debug login — use an @example.test address."}
                      </div>
                      <div className={styles.directRow}>
                        <input
                          type="email"
                          required
                          className={styles.directInput}
                          value={email}
                          onChange={(e) => onEmailChange(e.target.value)}
                          placeholder="you@example.test"
                        />
                        <button
                          type="submit"
                          className={`${styles.button} ${styles.buttonDark}`}
                          disabled={!email.trim() || submitting}
                        >
                          {submitting ? "Signing in…" : claiming ? "Sign in as admin" : "Sign in"}
                        </button>
                      </div>
                      {error && (
                        <div role="alert" className={styles.directError}>
                          {error}
                        </div>
                      )}
                    </form>
                  )}

                  {claiming && (
                    <p className={styles.claimFoot}>
                      This claim screen disappears once an administrator exists.
                    </p>
                  )}

                  <div className={styles.securityStrip}>
                    <LockGlyph />
                    <span>Self-hosted · Credentials stay server-side · Owner-scoped transcripts</span>
                  </div>
                </div>
              </div>

              <HeroMeetingScene />
            </div>
          </div>
        </section>

        {/* MARQUEE TICKER */}
        <div className={styles.ticker} aria-label="What TINA supports">
          <div className={styles.tickerTrack}>
            {TICKER_ITEMS.concat(TICKER_ITEMS).map((label, idx) => (
              <span
                key={`${label}-${idx}`}
                className={styles.tickerItem}
                aria-hidden={idx >= TICKER_ITEMS.length ? true : undefined}
              >
                {label}
                <span className={styles.tickerStar} aria-hidden="true">✦</span>
              </span>
            ))}
          </div>
        </div>

        {/* 01 · HOW IT WORKS */}
        <section className={styles.homeHow} id="how">
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>01 · HOW IT WORKS</span>
              <h2 className={styles.sectionTitle}>
                One Google sign-in.<br />
                <span className={styles.serif}>TINA</span> is in the meeting.
              </h2>
              <p className={styles.sectionSub}>
                Authenticate into your self-hosted workspace, choose your AI model and speech engine once, then dispatch TINA Bot from the web app, Chrome Extension, or calendar.
              </p>
              <span className={styles.liveTag}>READY IN &lt; 2 MINUTES</span>
            </div>

            <div className={styles.stepsGrid}>
              <article className={styles.stepCard}>
                <div className={styles.stepArt}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/landing/step1.png" alt="" width={1024} height={1024} />
                </div>
                <div className={styles.stepBody}>
                  <div className={styles.stepKicker}>
                    <span className={styles.stepNumber}>01</span>
                    <span className={styles.stepSymbol} aria-hidden="true">↓</span>
                    <span>SIGN IN</span>
                  </div>
                  <h3>Connect your workspace.</h3>
                  <p>
                    Sign in with Google OAuth to open your personal or team workspace. Link Google or Outlook calendars so upcoming meetings appear automatically.
                  </p>
                </div>
              </article>

              <article className={styles.stepCard}>
                <div className={styles.stepArt}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/landing/step2.png" alt="" width={1024} height={1024} />
                </div>
                <div className={styles.stepBody}>
                  <div className={styles.stepKicker}>
                    <span className={styles.stepNumber}>02</span>
                    <span className={`${styles.stepSymbol} ${styles.stepSymbolBlue}`} aria-hidden="true">◇</span>
                    <span>MODELS</span>
                  </div>
                  <h3>Bring your own AI &amp; STT.</h3>
                  <p>
                    Pick ChatGPT Plan, Claude, Gemini, DeepSeek, Groq, or AWS Bedrock in Settings — paired with VieGem + LM, Whisper, or Soniox transcription.
                  </p>
                </div>
              </article>

              <article className={styles.stepCard}>
                <div className={styles.stepArt}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/landing/step3.png" alt="" width={1024} height={1024} />
                </div>
                <div className={styles.stepBody}>
                  <div className={styles.stepKicker}>
                    <span className={styles.stepNumber}>03</span>
                    <span className={`${styles.stepSymbol} ${styles.stepSymbolOrange}`} aria-hidden="true">→</span>
                    <span>JOIN</span>
                  </div>
                  <h3>Send TINA &amp; speak live.</h3>
                  <p>
                    Paste a Google Meet, Zoom, or Teams link — or click Send Bot in Chrome Extension. Speak naturally to summon TINA in-call:
                  </p>
                  <button type="button" className={styles.snippet} onClick={() => void copyPrompt()}>
                    <code>“{WAKE_PROMPT}”</code>
                    <span className={`${styles.copyStatus} ${copiedPrompt ? styles.copyStatusDone : ""}`}>
                      {copiedPrompt ? "Copied" : "Copy"}
                    </span>
                  </button>
                </div>
              </article>
            </div>

            <div className={styles.proofBanner}>
              <strong>
                Bilingual transcription, <span className={styles.proofHighlight}>real-time voice answers</span>, and verifiable workspace memory — running entirely on{" "}
                <span className={styles.proofHighlight}>your own infrastructure</span>.
              </strong>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonLime}`}
                onClick={triggerPrimarySignIn}
              >
                <span>Open workspace</span>
                <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>
        </section>

        {/* 02 · LIVE TRANSCRIPT & VOICE AGENT */}
        <section className={styles.homeSection} id="transcription">
          <div className={styles.squiggle} aria-hidden="true" />
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>02 · LIVE TRANSCRIPT &amp; VOICE</span>
              <h2 className={styles.sectionTitle}>
                Know who said what — <span className={styles.serif}>and ask TINA out loud.</span>
              </h2>
              <p className={styles.sectionSub}>
                Live Vietnamese + English transcripts stream with speaker diarization, interleaved chronologically with TINA Agent’s spoken replies and clickable source citations.
              </p>
            </div>

            <div className={styles.transcriptShell}>
              <div className={styles.transcriptTop}>
                <span>LIVE TRANSCRIPT · SONG NGỮ VI + EN</span>
                <span className={styles.statusLive}>LIVE</span>
              </div>
              <div className={styles.transcriptLines}>
                {DEMO_LINES.map((row, idx) => (
                  <div
                    key={row.time}
                    className={`${styles.transcriptLine} ${row.isAgent ? styles.transcriptLineAgent : ""} ${idx !== activeLine && !row.isAgent ? styles.transcriptLineDim : ""}`}
                  >
                    <span className={`${styles.avatar} ${row.isAgent ? styles.avatarAgent : ""}`} aria-hidden="true">
                      {row.initials}
                    </span>
                    <div>
                      <div className={styles.speakerRow}>
                        <span className={`${styles.speaker} ${row.isAgent ? styles.speakerAgent : ""}`}>
                          {row.speaker}
                        </span>
                        {row.badge && <span className={styles.voiceBadge}>{row.badge}</span>}
                      </div>
                      <div className={styles.txPrimary}>“{row.primary}”</div>
                      <span className={styles.txSecondary}>{row.secondary}</span>
                    </div>
                    <time className={styles.txTime}>{row.time}</time>
                  </div>
                ))}
              </div>
              <ul className={styles.transcriptFoot}>
                <li>Speaker diarization &amp; Talk Time — per-speaker WPM and share</li>
                <li>Live VI + EN translation overlay — grouped by complete phrases</li>
                <li>“Tina ơi” Voice TTS — answers aloud with clickable Nguồn citations</li>
                <li>Audio-synced playback — click any turn to seek directly in the recording</li>
              </ul>
            </div>
          </div>
        </section>

        {/* 03 · MODES */}
        <section className={styles.homeSection} id="modes">
          <div className={styles.squiggle} aria-hidden="true" />
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>03 · MODES</span>
              <h2 className={styles.sectionTitle}>
                One companion across <span className={styles.serif}>every stage</span> of the call.
              </h2>
              <p className={styles.sectionSub}>
                From joining the live room to in-call Google Meet assist and post-call synthesis, every surface stays synced to the same meeting record.
              </p>
            </div>

            <div className={styles.cardGrid3}>
              <article className={`${styles.modeCard} ${styles.inkCard}`}>
                <span className={styles.miniLabel}>MEETING BOT</span>
                <h3>Live Voice &amp; Capture</h3>
                <p>
                  Joins Google Meet, Zoom, or Teams as a visible participant, records audio to your private S3 bucket, transcribes live, and replies via VieNeu TTS when called.
                </p>
                <span className={styles.bestFor}>Best for: bilingual teams, live Q&amp;A, hands-free notes</span>
              </article>

              <article className={`${styles.modeCard} ${styles.inkCard}`}>
                <span className={styles.miniLabel}>CHROME EXTENSION</span>
                <h3>In-call Meet Overlay</h3>
                <p>
                  Floating side panel right inside Google Meet showing live VI + EN rows, 60-second catch-up, Ask TINA with citations, and one-click Save to Wiki.
                </p>
                <span className={styles.bestFor}>Best for: staying present inside Google Meet without tab switching</span>
              </article>

              <article className={`${styles.modeCard} ${styles.inkCard}`}>
                <span className={styles.miniLabel}>WORKSPACE &amp; TERMINAL</span>
                <h3>Meeting Memory &amp; Routines</h3>
                <p>
                  3-column meeting detail with Smart Search, Speaker Talk Time, Executive Summary, Action Items, Ask Tina with MCP approvals, and scheduled Routines.
                </p>
                <span className={styles.bestFor}>Best for: follow-ups, team knowledge, automated recaps</span>
              </article>
            </div>
          </div>
        </section>

        {/* 04 · CAPABILITIES */}
        <section className={`${styles.homeSection} ${styles.homeSectionTinted}`} id="capabilities">
          <div className={styles.squiggle} aria-hidden="true" />
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>04 · CAPABILITIES</span>
              <h2 className={styles.sectionTitle}>
                Meeting awareness — <span className={styles.serif}>grounded in real evidence.</span>
              </h2>
              <p className={styles.sectionSub}>
                Every summary, voice answer, and Wiki page links straight back to exact transcript lines so your team can verify every claim in one click.
              </p>
            </div>

            <div className={styles.awarenessGrid}>
              <article className={styles.awarenessColumn}>
                <h3>Listens &amp; captures</h3>
                <ul className={styles.featureList}>
                  {CAPABILITIES_LISTEN.map((item) => (
                    <li key={item.label} className={styles.featureRow}>
                      <span className={styles.featureDot} aria-hidden="true" />
                      <div className={styles.featureContent}>
                        <strong>{item.label}</strong>
                        <span>{item.text}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </article>

              <article className={styles.awarenessColumn}>
                <h3>Acts &amp; remembers</h3>
                <ul className={styles.featureList}>
                  {CAPABILITIES_ACT.map((item) => (
                    <li key={item.label} className={styles.featureRow}>
                      <span className={`${styles.featureDot} ${styles.featureDotOrange}`} aria-hidden="true" />
                      <div className={styles.featureContent}>
                        <strong>{item.label}</strong>
                        <span>{item.text}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              </article>
            </div>
          </div>
        </section>

        {/* 05 · SELF-HOSTED PRIVACY */}
        <section className={styles.homeSection} id="privacy">
          <div className={styles.squiggle} aria-hidden="true" />
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>05 · DATA PRIVACY</span>
              <h2 className={styles.sectionTitle}>
                Your meetings stay <span className={styles.serif}>on your stack.</span>
              </h2>
              <p className={styles.sectionSub}>
                TINA is built self-hosted from the ground up — from local Docker Compose to private AWS VPC / ECS Fargate with RDS PostgreSQL, ElastiCache Valkey, and private S3.
              </p>
            </div>

            <div className={styles.cardGrid3}>
              <article className={`${styles.modeCard} ${styles.inkCard}`}>
                <span className={styles.miniLabel}>A / YOUR INFRASTRUCTURE</span>
                <h3>Docker or AWS ECS.</h3>
                <p>
                  Run TINA locally on Docker / OrbStack or deploy inside your own AWS VPC with private subnets, ALB + CloudFront, and encrypted storage.
                </p>
              </article>

              <article className={`${styles.modeCard} ${styles.inkCard}`}>
                <span className={styles.miniLabel}>B / SERVER-SIDE SECRETS</span>
                <h3>Keys never reach the browser.</h3>
                <p>
                  LLM API keys, OAuth tokens, and speech credentials are kept server-side and injected from Secrets Manager — never exposed to client JS.
                </p>
              </article>

              <article className={`${styles.modeCard} ${styles.inkCard}`}>
                <span className={styles.miniLabel}>C / OWNER-SCOPED</span>
                <h3>Default-deny permissions.</h3>
                <p>
                  Every meeting transcript, recording, and shared workspace is strictly scoped to its owner and invited teammates — never used for third-party training.
                </p>
              </article>
            </div>
          </div>
        </section>

        {/* 06 · PLATFORMS & MODELS */}
        <section className={styles.homeSection} id="platforms">
          <div className={styles.container}>
            <div className={styles.platformShowcase}>
              <div className={styles.sectionHead}>
                <span className={styles.sectionLabel}>06 · WORKS EVERYWHERE</span>
                <h2 className={styles.sectionTitle}>
                  Built for <span className={styles.serif}>your</span> platforms &amp; models.
                </h2>
                <p className={styles.sectionSub}>
                  Connect the meeting tools your team already lives in and switch AI providers or speech backends anytime without rewriting workflows.
                </p>
              </div>

              <div className={styles.platformPanels}>
                <div className={styles.platformPanel}>
                  <h3>MEETING PLATFORMS &amp; CLIENTS</h3>
                  <ul className={styles.platformList}>
                    <li>Google Meet</li>
                    <li>Zoom</li>
                    <li>Microsoft Teams</li>
                    <li>TINA Web Workspace</li>
                    <li>TINA Chrome Extension</li>
                    <li>TINA Developer Terminal</li>
                  </ul>
                </div>

                <div className={styles.platformPanel}>
                  <h3>AI PROVIDERS &amp; SPEECH ENGINES</h3>
                  <ul className={styles.platformList}>
                    <li>ChatGPT Plan (OAuth)</li>
                    <li>Claude / Anthropic</li>
                    <li>Google Gemini &amp; AWS Bedrock</li>
                    <li>DeepSeek, Groq &amp; Custom Gateways</li>
                    <li>VieGem + LM · Whisper · Soniox STT</li>
                    <li>VieNeu TTS &amp; LiveKit Voice</li>
                  </ul>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 07 · FAQ */}
        <section className={styles.homeSection} id="faq">
          <div className={styles.squiggle} aria-hidden="true" />
          <div className={styles.container}>
            <div className={`${styles.sectionHead} ${styles.sectionHeadCenter}`}>
              <span className={styles.sectionLabel}>07 · FAQ</span>
              <h2 className={styles.sectionTitle}>
                Common questions.<br />
                <span className={styles.serif}>Straight</span> answers.
              </h2>
            </div>

            <div className={styles.narrow}>
              <div className={styles.faqList}>
                {FAQ_ITEMS.map((item, idx) => {
                  const isOpen = openFaq === idx;
                  return (
                    <details
                      key={item.q}
                      className={styles.faqItem}
                      open={isOpen}
                      onToggle={(e) => {
                        const target = e.currentTarget;
                        if (target.open) setOpenFaq(idx);
                        else if (openFaq === idx) setOpenFaq(null);
                      }}
                    >
                      <summary className={styles.faqQ}>
                        <span>{item.q}</span>
                        <span className={`${styles.faqSign} ${isOpen ? styles.faqSignOpen : ""}`} aria-hidden="true">
                          {isOpen ? "×" : "+"}
                        </span>
                      </summary>
                      <div className={styles.faqAnswer}>{item.a}</div>
                    </details>
                  );
                })}
              </div>
            </div>
          </div>
        </section>

        {/* FINAL CTA */}
        <section className={styles.ctaSection} id="home-cta">
          <div className={styles.container}>
            <div className={styles.ctaInner}>
              <h2>
                Ready for your<br />
                <span className={styles.serif}>next meeting?</span>
              </h2>
              <p>
                Sign in to your self-hosted TINA workspace to capture bilingual transcripts, speak with TINA in-call, and turn discussions into action.
              </p>
              <div className={styles.ctaActions}>
                <button
                  type="button"
                  className={`${styles.button} ${styles.buttonLime}`}
                  onClick={triggerPrimarySignIn}
                >
                  <span>{claiming ? "Claim administrator access" : "Sign in to TINA"}</span>
                  <span aria-hidden="true">→</span>
                </button>
                <a className={`${styles.button} ${styles.buttonSoft}`} href="#home-hero">
                  Back to top ↑
                </a>
              </div>
            </div>
          </div>
        </section>
      </main>

      <footer className={styles.siteFooter}>
        <div className={styles.container}>
          <div className={styles.footerGrid}>
            <div className={styles.footerBrand}>
              <a className={styles.wordmark} href="#home-hero" aria-label="TINA home">
                <span className={styles.wordmarkBadge}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src="/tina-logo.svg" alt="" width={20} height={20} />
                </span>
                <span className={styles.wordmarkName}>TINA</span>
              </a>
              <p>
                Self-hosted AI meeting companion for Google Meet, Zoom, and Microsoft Teams — with bilingual transcription, live voice answers, and shared workspace memory.
              </p>
            </div>

            <div className={styles.footerCol}>
              <h4>Product</h4>
              <ul>
                <li><a href="#how">How it works</a></li>
                <li><a href="#transcription">Live Transcript &amp; Voice</a></li>
                <li><a href="#modes">Bot, Extension &amp; Workspace</a></li>
                <li><a href="#capabilities">Capabilities</a></li>
              </ul>
            </div>

            <div className={styles.footerCol}>
              <h4>Architecture</h4>
              <ul>
                <li><a href="#privacy">Self-hosted Privacy</a></li>
                <li><a href="#platforms">Platforms &amp; Models</a></li>
                <li><a href="#faq">FAQ</a></li>
              </ul>
            </div>

            <div className={styles.footerCol}>
              <h4>Workspace</h4>
              <ul>
                <li>
                  <button type="button" onClick={triggerPrimarySignIn}>
                    {claiming ? "Set up instance" : "Sign in"}
                  </button>
                </li>
                <li><a href="#signin">Authentication options</a></li>
              </ul>
            </div>
          </div>

          <div className={styles.footerBottom}>
            <span>© 2026 TINA — Self-hosted AI Meeting Companion.</span>
            <span>Listen clearly. Act together.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}

function LockGlyph() {
  return (
    <svg width={13} height={13} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2.5" y="7.2" width="11" height="7" rx="1.6" />
      <path d="M4.8 7.2V4.8a3.2 3.2 0 0 1 6.4 0v2.4" />
    </svg>
  );
}
