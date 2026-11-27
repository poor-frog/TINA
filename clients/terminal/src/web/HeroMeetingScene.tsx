"use client";
/** HeroMeetingScene — Interactive layered animation built from the original hero.png
 *  hand-drawn ink illustration. Fully bilingual (VI / EN) with sample
 *  meeting beats, rolling cel bot, CRT voice equalizer, and clickable characters. */
import { useCallback, useEffect, useState, type MouseEvent } from "react";
import { LANDING_COPY, type LandingLang, type SceneBeatId } from "./landingCopy";
import styles from "./heroMeetingScene.module.css";

const BEAT_ORDER: SceneBeatId[] = ["minh", "linh", "tina-reply", "lan"];

export function HeroMeetingScene({ lang = "vi" }: { lang?: LandingLang }) {
  const copy = LANDING_COPY[lang].scene;
  const [beat, setBeat] = useState<SceneBeatId>("minh");
  const [botSeated, setBotSeated] = useState(false);
  const [autoplay, setAutoplay] = useState(true);
  const [gaze, setGaze] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!autoplay || typeof window === "undefined") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    const timer = window.setInterval(() => {
      setBeat((cur) => {
        const next = BEAT_ORDER[(BEAT_ORDER.indexOf(cur) + 1) % BEAT_ORDER.length];
        setBotSeated(LANDING_COPY[lang].scene.beats[next].botSeated);
        return next;
      });
    }, 3400);

    return () => window.clearInterval(timer);
  }, [autoplay, lang]);

  const selectBeat = useCallback(
    (next: SceneBeatId) => {
      setAutoplay(false);
      setBeat(next);
      setBotSeated(copy.beats[next].botSeated);
    },
    [copy],
  );

  const toggleBotSeat = useCallback(() => {
    setAutoplay(false);
    setBotSeated((prev) => {
      const next = !prev;
      setBeat(next ? "tina-reply" : "minh");
      return next;
    });
  }, []);

  const onPointerMove = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const nx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    const ny = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    setGaze({ x: Math.max(-1, Math.min(1, nx)) * 5, y: Math.max(-1, Math.min(1, ny)) * 4 });
  }, []);

  const onPointerLeave = useCallback(() => {
    setGaze({ x: 0, y: 0 });
  }, []);

  const current = copy.beats[beat];
  const tinaSpeaking = beat === "tina-reply";
  const tinaListening = beat === "linh";
  const bubblePosKey = current.isAgent && !botSeated ? "posBotRight" : current.posClass;

  return (
    <figure className={styles.stageWrap} aria-label={copy.ariaLabel}>
      <div
        className={styles.stage}
        onMouseMove={onPointerMove}
        onMouseLeave={onPointerLeave}
      >
        {/* Base conference table + 3 teammates + seated AI companion */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/hero-table.png"
          alt={copy.imgAlt}
          width={1376}
          height={768}
          className={`${styles.layerImg} ${styles.layerMultiply}`}
        />

        {/* Animated hand-drawn scribble speech bubbles above the 3 teammates */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/hero-bubble-1.png"
          alt=""
          aria-hidden="true"
          width={1376}
          height={768}
          className={`${styles.bubbleLayer} ${styles.bubble1} ${current.activeHumanBubble === 1 ? styles.bubbleActive : ""}`}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/hero-bubble-2.png"
          alt=""
          aria-hidden="true"
          width={1376}
          height={768}
          className={`${styles.bubbleLayer} ${styles.bubble2} ${current.activeHumanBubble === 2 ? styles.bubbleActive : ""}`}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/hero-bubble-3.png"
          alt=""
          aria-hidden="true"
          width={1376}
          height={768}
          className={`${styles.bubbleLayer} ${styles.bubble3} ${current.activeHumanBubble === 3 ? styles.bubbleActive : ""}`}
        />

        {/* Seated Bot CRT Screen + Animated Curved Trajectory Arrow */}
        <svg viewBox="0 0 1376 768" className={styles.overlaySvg} aria-hidden="true">
          <rect
            x="311"
            y="147"
            width="71"
            height="72"
            rx="10"
            className={`${styles.crtGlow} ${tinaSpeaking || tinaListening ? styles.crtGlowActive : ""}`}
          />
          {tinaSpeaking ? (
            <g transform={`translate(${gaze.x * 0.4}, ${gaze.y * 0.4})`}>
              <rect x="327" y="178" width="5" height="22" className={styles.eqBar} />
              <rect x="336" y="168" width="5" height="32" className={`${styles.eqBar} ${styles.eqBar2}`} />
              <rect x="345" y="162" width="5" height="38" className={`${styles.eqBar} ${styles.eqBar3}`} />
              <rect x="354" y="170" width="5" height="30" className={`${styles.eqBar} ${styles.eqBar4}`} />
              <rect x="363" y="177" width="5" height="23" className={`${styles.eqBar} ${styles.eqBar5}`} />
            </g>
          ) : (
            <g transform={`translate(${gaze.x}, ${gaze.y})`}>
              <path
                d="M361 157 C362 172 365 175 374 177 C365 179 362 182 361 197 C360 182 357 179 348 177 C357 175 360 172 361 157 Z"
                className={styles.sparkle}
              />
            </g>
          )}

          <g className={`${styles.arrowGroup} ${botSeated ? styles.arrowHidden : ""}`}>
            <path d="M 1106 565 C 1015 628, 845 634, 718 546" className={styles.arrowDash} />
            <path d="M 727 540 L 708 538 L 716 557" className={styles.arrowHead} />
          </g>
        </svg>

        {/* Rolling TINA Bot Unit */}
        <div className={`${styles.botRig} ${botSeated ? styles.botRigSeated : styles.botRigIdle}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/landing/hero-puff.png"
            alt=""
            aria-hidden="true"
            width={1376}
            height={768}
            className={`${styles.puffLayer} ${botSeated ? styles.puffBurst : ""}`}
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/landing/hero-bot.png"
            alt=""
            aria-hidden="true"
            width={1376}
            height={768}
            className={styles.botCel}
          />
          <svg viewBox="0 0 1376 768" className={styles.overlaySvg} aria-hidden="true">
            <rect
              x="1124"
              y="209"
              width="77"
              height="74"
              rx="10"
              className={`${styles.crtGlow} ${tinaSpeaking || botSeated ? styles.crtGlowActive : ""}`}
            />
            {tinaSpeaking ? (
              <g transform={`translate(${gaze.x * 0.4}, ${gaze.y * 0.4})`}>
                <rect x="1142" y="242" width="5.5" height="22" className={styles.eqBar} />
                <rect x="1151" y="230" width="5.5" height="34" className={`${styles.eqBar} ${styles.eqBar2}`} />
                <rect x="1160" y="224" width="5.5" height="40" className={`${styles.eqBar} ${styles.eqBar3}`} />
                <rect x="1169" y="232" width="5.5" height="32" className={`${styles.eqBar} ${styles.eqBar4}`} />
                <rect x="1178" y="240" width="5.5" height="24" className={`${styles.eqBar} ${styles.eqBar5}`} />
              </g>
            ) : (
              <g transform={`translate(${gaze.x}, ${gaze.y})`}>
                <path
                  d="M1183 224 C1184 238 1187 241 1195 243 C1187 245 1184 248 1183 262 C1182 248 1179 245 1171 243 C1179 241 1182 238 1183 224 Z"
                  className={styles.sparkle}
                />
              </g>
            )}
          </svg>
        </div>

        {/* Live interactive comic speech bubble */}
        <div
          key={`${lang}-${beat}-${botSeated ? "in" : "out"}`}
          className={`${styles.speechBubble} ${current.isAgent ? styles.speechBubbleAgent : ""} ${styles[bubblePosKey]}`}
          role="status"
          aria-live="polite"
        >
          <div className={styles.speechMeta}>
            <span className={styles.speechDot} aria-hidden="true" />
            <span>{current.speaker}</span>
            <span>·</span>
            <span>{current.badge}</span>
          </div>
          <p className={styles.speechText}>{current.text}</p>
          <span className={styles.speechSub}>{current.sub}</span>
        </div>

        {/* Interactive clickable character hotspots */}
        <button
          type="button"
          className={`${styles.hotspot} ${styles.hotspotMinh}`}
          aria-label={copy.hotspots.minh}
          title={copy.hotspots.minh}
          onClick={() => selectBeat("minh")}
        />
        <button
          type="button"
          className={`${styles.hotspot} ${styles.hotspotSeatedBot}`}
          aria-label={copy.hotspots.seatedBot}
          title={copy.hotspots.seatedBot}
          onClick={() => selectBeat("tina-reply")}
        />
        <button
          type="button"
          className={`${styles.hotspot} ${styles.hotspotLinh}`}
          aria-label={copy.hotspots.linh}
          title={copy.hotspots.linh}
          onClick={() => selectBeat("linh")}
        />
        <button
          type="button"
          className={`${styles.hotspot} ${styles.hotspotJky}`}
          aria-label={copy.hotspots.lan}
          title={copy.hotspots.lan}
          onClick={() => selectBeat("lan")}
        />
        <button
          type="button"
          className={`${styles.hotspot} ${styles.hotspotRollingBot} ${botSeated ? styles.hotspotRollingBotSeated : ""}`}
          aria-label={botSeated ? copy.hotspots.rollingBotOut : copy.hotspots.rollingBotIn}
          title={botSeated ? copy.hotspots.rollingBotOut : copy.hotspots.rollingBotIn}
          onClick={toggleBotSeat}
        />
      </div>

      {/* Compact editorial interactive control strip */}
      <figcaption className={styles.controlBar}>
        <span className={styles.hintText}>{copy.demo}</span>
        <div className={styles.controlGroup}>
          <button
            type="button"
            className={`${styles.chip} ${beat === "tina-reply" ? styles.chipActive : ""}`}
            onClick={() => selectBeat("tina-reply")}
          >
            <span>{copy.callTina}</span>
          </button>
          <button
            type="button"
            className={`${styles.chip} ${botSeated ? styles.chipActive : ""}`}
            onClick={toggleBotSeat}
          >
            <span>{botSeated ? copy.leaveTable : copy.joinTable}</span>
          </button>
          <button
            type="button"
            className={styles.chip}
            onClick={() => setAutoplay((v) => !v)}
            aria-pressed={autoplay}
          >
            <span>{autoplay ? copy.autoplayOn : copy.autoplayPaused}</span>
          </button>
        </div>
      </figcaption>
    </figure>
  );
}
