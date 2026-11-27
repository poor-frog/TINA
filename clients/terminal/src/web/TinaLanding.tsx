"use client";
/** TinaLanding — Bilingual (VI / EN, Vietnamese default) editorial pre-login landing
 *  & OAuth gate for TINA. Built for teams and enterprises: real-time VI+EN bilingual
 *  transcription, "Tina ơi" Voice TTS with source citations, Google Meet Chrome Extension
 *  spotlight, interactive cel-animated Hero scene, and private-infrastructure governance. */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { HeroMeetingScene } from "./HeroMeetingScene";
import { LandingKnowledgeGraphCard } from "./LandingKnowledgeGraphCard";
import { LANDING_COPY, type LandingLang } from "./landingCopy";
import { PrivateInfraIso } from "./PrivateInfraIso";
import { StepScene } from "./StepScene";
import "./lucian/lucianTokens.css";
import { LucianAutomationFlow } from "./lucian/LucianAutomationFlow";
import { LucianBentoGrid } from "./lucian/LucianBentoGrid";
import { LucianCursorGlowGrid } from "./lucian/LucianCursorGlowGrid";
import { LucianGlowCta } from "./lucian/LucianGlowCta";
import styles from "./tinaLanding.module.css";
import "./tokens.css";

const LANG_STORAGE_KEY = "tina.landing.lang";

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

type ExtPreviewTab = "bilingual" | "catchup" | "ask";

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
  const [lang, setLang] = useState<LandingLang>("vi");
  const [scrolled, setScrolled] = useState(false);
  const [scrollPct, setScrollPct] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [activeLine, setActiveLine] = useState(2);
  const [extTab, setExtTab] = useState<ExtPreviewTab>("bilingual");
  const [wikiSaved, setWikiSaved] = useState(false);
  const [openFaq, setOpenFaq] = useState<number | null>(0);
  const [copiedPrompt, setCopiedPrompt] = useState(false);
  const [kgPulseKey, setKgPulseKey] = useState(0);

  const copy = LANDING_COPY[lang];
  const hasOAuth = providers.google || providers.microsoft;

  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LANG_STORAGE_KEY);
      if (saved === "vi" || saved === "en") setLang(saved);
    } catch {
      // Ignore storage access errors in restricted contexts.
    }
  }, []);

  const switchLang = (next: LandingLang) => {
    setLang(next);
    try {
      window.localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // Ignore storage access errors.
    }
  };

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
      setActiveLine((cur) => (cur + 1) % LANDING_COPY.vi.live.lines.length);
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
      await navigator.clipboard?.writeText(copy.how.steps[2].wakePrompt);
      setCopiedPrompt(true);
      window.setTimeout(() => setCopiedPrompt(false), 1800);
    } catch {
      setCopiedPrompt(false);
    }
  };

  return (
    <div className={`tina-landing ${styles.root}`} lang={lang}>
      <div className={styles.grain} aria-hidden="true" />
      <div className={styles.scrollBar} style={{ transform: `scaleX(${scrollPct / 100})` }} aria-hidden="true" />

      <header className={`${styles.navWrap} ${scrolled ? styles.navWrapScrolled : ""}`}>
        <div className={styles.container}>
          <nav className={styles.navRow} aria-label="Primary">
            <a className={styles.wordmark} href="#home-hero" aria-label="TINA home">
              <span className={styles.wordmarkBadge}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/tina-logo.svg" alt="" width={20} height={20} />
              </span>
              <span className={styles.wordmarkName}>TINA</span>
            </a>

            <div className={styles.navLinks}>
              <a href="#transcription">{copy.nav.live}</a>
              <a href="#extension">{copy.nav.extension}</a>
              <a href="#how">{copy.nav.how}</a>
              <a href="#use-cases">{copy.nav.useCases}</a>
              <a href="#privacy">{copy.nav.privacy}</a>
              <a href="#faq">{copy.nav.faq}</a>
            </div>

            <div className={styles.navActions}>
              <div className={styles.langSwitch} role="group" aria-label="Language">
                <button
                  type="button"
                  className={`${styles.langBtn} ${lang === "vi" ? styles.langBtnActive : ""}`}
                  aria-pressed={lang === "vi"}
                  onClick={() => switchLang("vi")}
                >
                  VI
                </button>
                <button
                  type="button"
                  className={`${styles.langBtn} ${lang === "en" ? styles.langBtnActive : ""}`}
                  aria-pressed={lang === "en"}
                  onClick={() => switchLang("en")}
                >
                  EN
                </button>
              </div>

              <button
                type="button"
                className={`${styles.button} ${styles.buttonDark} ${styles.navSignIn}`}
                onClick={triggerPrimarySignIn}
              >
                <span>{claiming ? copy.nav.claimAdmin : copy.nav.signIn}</span>
              </button>

              <button
                type="button"
                className={styles.navToggle}
                aria-label={copy.nav.toggleNav}
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
            <a href="#transcription" onClick={() => setMenuOpen(false)}>{copy.nav.live}</a>
            <a href="#extension" onClick={() => setMenuOpen(false)}>{copy.nav.extension}</a>
            <a href="#how" onClick={() => setMenuOpen(false)}>{copy.nav.how}</a>
            <a href="#use-cases" onClick={() => setMenuOpen(false)}>{copy.nav.useCases}</a>
            <a href="#privacy" onClick={() => setMenuOpen(false)}>{copy.nav.privacy}</a>
            <a href="#faq" onClick={() => setMenuOpen(false)}>{copy.nav.faq}</a>
          </nav>
        )}
      </header>

      <main className={styles.main}>
        {/* HERO + OAUTH SIGN-IN + INTERACTIVE SCENE */}
        <section className={styles.homeHero} id="home-hero">
          <div className={styles.container}>
            <div className={styles.heroGrid}>
              <div className={styles.heroCopy}>
                {claiming && (
                  <div className={styles.claimBadge}>
                    <span className={styles.claimDot} aria-hidden="true" />
                    <span>{copy.hero.claimBadge}</span>
                  </div>
                )}

                <h1 className={styles.heroTitle}>
                  {claiming ? copy.hero.claimHeading : copy.hero.title}
                </h1>

                <p className={styles.heroLead}>
                  {claiming ? copy.hero.claimLead : copy.hero.lead}
                </p>

                <div className={styles.authBox} id="signin">
                  {claiming && !hasOAuth && directLoginAvailable && (
                    <div className={styles.notice}>
                      {copy.hero.devNoticePrefix}
                      <code>GOOGLE_CLIENT_ID</code>/<code>SECRET</code> · <code>MICROSOFT_CLIENT_ID</code>/<code>SECRET</code>
                      {copy.hero.devNoticeSuffix}
                    </div>
                  )}

                  {claiming && !hasOAuth && !directLoginAvailable && (
                    <div className={styles.notice}>{copy.hero.noOAuthClaimNotice}</div>
                  )}

                  {!claiming && !hasOAuth && !directLoginAvailable && (
                    <div className={styles.notice}>{copy.hero.noOAuthNotice}</div>
                  )}

                  <div className={styles.heroActions}>
                    {providers.google && (
                      <button
                        type="button"
                        className={`${styles.button} ${styles.buttonLime} ${styles.oauthBtn}`}
                        onClick={() => onOAuthSignIn("google")}
                      >
                        {googleIcon}
                        <span>{copy.hero.googleCta}</span>
                      </button>
                    )}

                    {providers.microsoft && (
                      <button
                        type="button"
                        className={`${styles.button} ${styles.oauthBtn}`}
                        onClick={() => onOAuthSignIn("microsoft")}
                      >
                        {microsoftIcon}
                        <span>{copy.hero.microsoftCta}</span>
                      </button>
                    )}

                    <a className={styles.buttonPlain} href="#transcription">
                      <span>{copy.hero.secondaryCta}</span>
                      <span aria-hidden="true">↓</span>
                    </a>
                  </div>

                  {hasOAuth && directLoginAvailable && (
                    <button type="button" className={styles.debugToggle} onClick={onToggleDebug}>
                      {showDebug ? copy.hero.debugHide : copy.hero.debugShow}
                    </button>
                  )}

                  {directLoginAvailable && (!hasOAuth || showDebug) && (
                    <form className={styles.directForm} onSubmit={onDirectSubmit}>
                      <div className={styles.directHint}>
                        {claiming && !hasOAuth ? copy.hero.directHintClaim : copy.hero.directHintDebug}
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
                          {submitting
                            ? copy.hero.directSubmitting
                            : claiming
                              ? copy.hero.directSubmitAdmin
                              : copy.hero.directSubmit}
                        </button>
                      </div>
                      {error && (
                        <div role="alert" className={styles.directError}>
                          {error}
                        </div>
                      )}
                    </form>
                  )}

                  {claiming && <p className={styles.claimFoot}>{copy.hero.claimFoot}</p>}

                </div>
              </div>

              <HeroMeetingScene lang={lang} />
            </div>
          </div>
        </section>

        {/* 01 · LIVE IN-CALL TRANSCRIPT & VOICE AGENT (moved up right after Hero!) */}
        <section className={styles.homeSection} id="transcription">
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>{copy.live.label}</span>
              <h2 className={styles.sectionTitle}>
                {copy.live.titleLead}
                {copy.live.titleSerif}
              </h2>
              <p className={styles.sectionSub}>{copy.live.sub}</p>
            </div>

            <div className={styles.transcriptShell}>
              <div className={styles.transcriptTop}>
                <span>{copy.live.shellTitle}</span>
                <span>{copy.scene.demo}</span>
              </div>
              <div className={styles.transcriptLines}>
                {copy.live.lines.map((row, idx) => (
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
                {copy.live.bullets.map((bullet) => (
                  <li key={bullet}>{bullet}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* 02 · TINA CHROME EXTENSION SPOTLIGHT */}
        <section className={`${styles.homeSection} ${styles.homeSectionTinted}`} id="extension">
          <div className={styles.squiggle} aria-hidden="true" />
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>{copy.extension.label}</span>
              <h2 className={styles.sectionTitle}>
                {copy.extension.titleLead}
                {copy.extension.titleSerif}
              </h2>
              <p className={styles.sectionSub}>{copy.extension.sub}</p>
            </div>

            <div className={styles.extGrid}>
              <div className={styles.extPoints}>
                {copy.extension.points.map((pt) => (
                  <article key={pt.tag} className={styles.extPointCard}>
                    <div className={styles.extPointHead}>
                      <span className={styles.extPointTag}>{pt.tag}</span>
                      <h3>{pt.title}</h3>
                    </div>
                    <p>{pt.body}</p>
                  </article>
                ))}
              </div>

              <div className={styles.extPreview} aria-label="TINA Chrome Extension interactive preview">
                <div className={styles.extPreviewTop}>
                  <span className={styles.extPreviewDots} aria-hidden="true">
                    <i />
                    <i />
                    <i />
                  </span>
                  <span className={styles.extPreviewUrl}>{copy.scene.demo}</span>
                </div>

                <div className={styles.extTabBar} role="tablist" aria-label="Chrome Extension features">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={extTab === "bilingual"}
                    className={`${styles.extTab} ${extTab === "bilingual" ? styles.extTabActive : ""}`}
                    onClick={() => setExtTab("bilingual")}
                  >
                    {copy.extension.tabs.bilingual}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={extTab === "catchup"}
                    className={`${styles.extTab} ${extTab === "catchup" ? styles.extTabActive : ""}`}
                    onClick={() => setExtTab("catchup")}
                  >
                    {copy.extension.tabs.catchup}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={extTab === "ask"}
                    className={`${styles.extTab} ${extTab === "ask" ? styles.extTabActive : ""}`}
                    onClick={() => setExtTab("ask")}
                  >
                    {copy.extension.tabs.ask}
                  </button>
                </div>

                <div className={styles.extBody} role="tabpanel">
                  {extTab === "bilingual" &&
                    copy.extension.bilingualRows.map((row) => (
                      <div key={row.time} className={styles.extRow}>
                        <div className={styles.extRowMeta}>
                          <span>{row.speaker}</span>
                          <span>{row.time}</span>
                        </div>
                        <p className={styles.extRowVi}>{row.vi}</p>
                        <p className={styles.extRowEn}>{row.en}</p>
                      </div>
                    ))}

                  {extTab === "catchup" && (
                    <>
                      <span className={styles.extCatchupTag}>{copy.extension.catchupWindow}</span>
                      <p className={styles.extCatchupLead}>{copy.extension.catchupSummary}</p>
                      <ul className={styles.extCatchupList}>
                        {copy.extension.catchupBullets.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </>
                  )}

                  {extTab === "ask" && (
                    <>
                      <div className={styles.extAskQ}>{copy.extension.askQuestion}</div>
                      <div className={styles.extAskA}>
                        <p>{copy.extension.askAnswer}</p>
                        <span className={styles.extAskCite}>{copy.extension.askCitation}</span>
                        <button
                          type="button"
                          className={styles.extWikiBtn}
                          onClick={() => setWikiSaved((v) => !v)}
                        >
                          {wikiSaved ? copy.extension.askWikiSaved : copy.extension.askWikiBtn}
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 03 · HOW IT WORKS (3 hand-drawn illustration cards) */}
        <section className={styles.homeHow} id="how">
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>{copy.how.label}</span>
              <h2 className={styles.sectionTitle}>
                {copy.how.titleLine1}
                {" "}
                {copy.how.titleSerif}
                {copy.how.titleLine2Rest}
              </h2>
              <p className={styles.sectionSub}>{copy.how.sub}</p>
            </div>

            <div className={styles.stepsGrid}>
              <article className={styles.stepCard}>
                <div className={styles.stepArt}>
                  <StepScene step={1} />
                </div>
                <div className={styles.stepBody}>
                  <div className={styles.stepKicker}>
                    <span className={styles.stepNumber}>01</span>
                    <span className={styles.stepSymbol} aria-hidden="true">↓</span>
                    <span>{copy.how.steps[0].kicker}</span>
                  </div>
                  <h3>{copy.how.steps[0].title}</h3>
                  <p>{copy.how.steps[0].body}</p>
                </div>
              </article>

              <article className={styles.stepCard}>
                <div className={styles.stepArt}>
                  <StepScene step={2} />
                </div>
                <div className={styles.stepBody}>
                  <div className={styles.stepKicker}>
                    <span className={styles.stepNumber}>02</span>
                    <span className={`${styles.stepSymbol} ${styles.stepSymbolBlue}`} aria-hidden="true">◇</span>
                    <span>{copy.how.steps[1].kicker}</span>
                  </div>
                  <h3>{copy.how.steps[1].title}</h3>
                  <p>{copy.how.steps[1].body}</p>
                </div>
              </article>

              <article className={styles.stepCard}>
                <div className={styles.stepArt}>
                  <StepScene step={3} />
                </div>
                <div className={styles.stepBody}>
                  <div className={styles.stepKicker}>
                    <span className={styles.stepNumber}>03</span>
                    <span>{copy.how.steps[2].kicker}</span>
                  </div>
                  <h3>{copy.how.steps[2].title}</h3>
                  <p>{copy.how.steps[2].body}</p>
                  <button type="button" className={styles.snippet} onClick={() => void copyPrompt()}>
                    <code>“{copy.how.steps[2].wakePrompt}”</code>
                    <span className={`${styles.copyStatus} ${copiedPrompt ? styles.copyStatusDone : ""}`}>
                      {copiedPrompt ? copy.how.copied : copy.how.copy}
                    </span>
                  </button>
                </div>
              </article>
            </div>

            <div className={styles.howInteractiveRow}>
              <LucianAutomationFlow lang={lang} onRunComplete={() => setKgPulseKey((k) => k + 1)} />
              <LandingKnowledgeGraphCard lang={lang} pulseKey={kgPulseKey} />
            </div>

            <div className={styles.proofBanner}>
              <strong>
                {copy.how.proofPrefix}
                <span className={styles.proofHighlight}>{copy.how.proofHighlight1}</span>
                {copy.how.proofMid}
                <span className={styles.proofHighlight}>{copy.how.proofHighlight2}</span>.
              </strong>
              <button
                type="button"
                className={`${styles.button} ${styles.buttonLime}`}
                onClick={triggerPrimarySignIn}
              >
                <span>{copy.how.proofCta}</span>
              </button>
            </div>
          </div>
        </section>

        {/* 04 · SYNCED SURFACES + ENTERPRISE USE CASES */}
        <section className={`${styles.homeSection} ${styles.homeSectionTinted}`} id="use-cases">
          <div className={styles.squiggle} aria-hidden="true" />
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>{copy.useCases.label}</span>
              <h2 className={styles.sectionTitle}>
                {copy.useCases.titleLead}
                {copy.useCases.titleSerif}
                {copy.useCases.titleTail}
              </h2>
              <p className={styles.sectionSub}>{copy.useCases.sub}</p>
            </div>

            <LucianBentoGrid lang={lang} />

            <div className={styles.cardGrid3}>
              {copy.useCases.surfaces.map((surface) => (
                <article key={surface.tag} className={`${styles.modeCard} ${styles.inkCard}`}>
                  <span className={styles.miniLabel}>{surface.tag}</span>
                  <h3>{surface.title}</h3>
                  <p>{surface.body}</p>
                  <span className={styles.bestFor}>{surface.bestFor}</span>
                </article>
              ))}
            </div>

            <div className={styles.casesBlock}>
              <h3 className={styles.casesSubhead}>{copy.useCases.casesHeading}</h3>
              <LucianCursorGlowGrid items={copy.useCases.cases} ariaLabel={copy.useCases.casesHeading} />
            </div>
          </div>
        </section>

        {/* 05 · PRIVACY + SUPPORTED PLATFORMS & MODELS */}
        <section className={styles.homeSection} id="privacy">
          <div className={styles.squiggle} aria-hidden="true" />
          <div className={styles.container}>
            <div className={styles.sectionHead}>
              <span className={styles.sectionLabel}>{copy.privacy.label}</span>
              <h2 className={styles.sectionTitle}>
                {copy.privacy.titleLead}
                {copy.privacy.titleSerif}
              </h2>
              <p className={styles.sectionSub}>{copy.privacy.sub}</p>
            </div>

            <div className={styles.privacyLayout}>
              <div className={styles.privacyDiagram}>
                <PrivateInfraIso lang={lang} />
              </div>

              <div className={styles.privacyClaims}>
                {copy.privacy.cards.map((card) => (
                  <article key={card.tag} className={`${styles.modeCard} ${styles.inkCard}`}>
                    <span className={styles.miniLabel}>{card.tag}</span>
                    <h3>{card.title}</h3>
                    <p>{card.body}</p>
                  </article>
                ))}
              </div>
            </div>

            <div className={styles.platformWrap} id="platforms">
              <div className={styles.platformShowcase}>
                <div className={styles.sectionHead}>
                  <span className={styles.sectionLabel}>{copy.privacy.platformsLabel}</span>
                  <h2 className={styles.sectionTitle}>
                    {copy.privacy.platformsTitleLead}
                    {copy.privacy.platformsTitleSerif}
                    {copy.privacy.platformsTitleTail}
                  </h2>
                  <p className={styles.sectionSub}>{copy.privacy.platformsSub}</p>
                </div>

                <div className={styles.platformPanels}>
                  <div className={styles.platformPanel}>
                    <h3>{copy.privacy.leftColTitle}</h3>
                    <ul className={styles.platformList}>
                      {copy.privacy.leftColItems.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>

                  <div className={styles.platformPanel}>
                    <h3>{copy.privacy.rightColTitle}</h3>
                    <ul className={styles.platformList}>
                      {copy.privacy.rightColItems.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 06 · FAQ */}
        <section className={styles.homeSection} id="faq">
          <div className={styles.squiggle} aria-hidden="true" />
          <div className={styles.container}>
            <div className={`${styles.sectionHead} ${styles.sectionHeadCenter}`}>
              <h2 className={styles.sectionTitle}>
                {copy.faq.label}
              </h2>
            </div>

            <div className={styles.narrow}>
              <div className={styles.faqList}>
                {copy.faq.items.map((item, idx) => {
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
            <LucianGlowCta
              titleLine1={copy.cta.titleLine1}
              titleSerif={copy.cta.titleSerif}
              sub={copy.cta.sub}
              primaryLabel={claiming ? copy.cta.primaryClaim : copy.cta.primary}
              secondaryLabel={copy.cta.backToTop}
              secondaryHref="#home-hero"
              onPrimaryClick={triggerPrimarySignIn}
            />
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
              <p>{copy.footer.tagline}</p>
            </div>

            <div className={styles.footerCol}>
              <h4>{copy.footer.col1}</h4>
              <ul>
                <li><a href="#transcription">{copy.nav.live}</a></li>
                <li><a href="#extension">{copy.nav.extension}</a></li>
                <li><a href="#how">{copy.nav.how}</a></li>
                <li><a href="#use-cases">{copy.nav.useCases}</a></li>
              </ul>
            </div>

            <div className={styles.footerCol}>
              <h4>{copy.footer.col2}</h4>
              <ul>
                <li><a href="#privacy">{copy.nav.privacy}</a></li>
                <li><a href="#platforms">{copy.privacy.platformsLabel}</a></li>
                <li><a href="#faq">{copy.nav.faq}</a></li>
              </ul>
            </div>

            <div className={styles.footerCol}>
              <h4>{copy.footer.col3}</h4>
              <ul>
                <li>
                  <button className={styles.footerSignIn} type="button" onClick={triggerPrimarySignIn}>
                    {claiming ? copy.footer.col3Claim : copy.footer.col3SignIn}
                  </button>
                </li>
                <li><a href="#signin">{copy.footer.col3AuthOptions}</a></li>
              </ul>
            </div>
          </div>

          <div className={styles.footerBottom}>
            <span>{copy.footer.copyright}</span>
            <span>{copy.footer.motto}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
