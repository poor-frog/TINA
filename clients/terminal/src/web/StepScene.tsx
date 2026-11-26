"use client";
/** StepScene — Layered cel animations built from the segmented step1/step2/step3
 *  hand-drawn ink illustrations with TINA Brand Mint (#6EE7B7) interactive accents. */
import { useEffect, useRef, useState } from "react";
import styles from "./stepScene.module.css";

export interface StepSceneProps {
  step: 1 | 2 | 3;
}

export function StepScene({ step }: StepSceneProps) {
  const [boosted, setBoosted] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, []);

  const triggerBoost = () => {
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    setBoosted(true);
    timerRef.current = window.setTimeout(() => {
      setBoosted(false);
      timerRef.current = null;
    }, 1500);
  };

  if (step === 1) {
    return (
      <div
        className={`${styles.stage} ${styles.stage1} ${boosted ? styles.boosted : ""}`}
        onClick={triggerBoost}
        aria-hidden="true"
      >
        <svg viewBox="0 0 1024 1024" className={styles.overlaySvg}>
          <ellipse cx="520" cy="410" rx="190" ry="64" className={styles.boxMintGlow} />
        </svg>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/step1-box.png"
          alt=""
          width={1024}
          height={1024}
          className={`${styles.layer} ${styles.s1Box}`}
        />
        <div className={styles.s1CardRig}>
          <svg viewBox="0 0 1024 1024" className={styles.overlaySvg}>
            <rect
              x="460"
              y="220"
              width="126"
              height="176"
              rx="18"
              transform="rotate(19 524 308)"
              className={styles.cardMintFill}
            />
          </svg>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/landing/step1-card.png"
            alt=""
            width={1024}
            height={1024}
            className={styles.layer}
          />
        </div>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/step1-sparks.png"
          alt=""
          width={1024}
          height={1024}
          className={`${styles.layer} ${styles.s1Sparks}`}
        />
      </div>
    );
  }

  if (step === 2) {
    return (
      <div
        className={`${styles.stage} ${styles.stage2} ${boosted ? styles.boosted : ""}`}
        onClick={triggerBoost}
        aria-hidden="true"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/step2-shadow.png"
          alt=""
          width={1024}
          height={1024}
          className={`${styles.layer} ${styles.s2Shadow}`}
        />
        <svg viewBox="0 0 1024 1024" className={styles.overlaySvg}>
          <circle cx="688" cy="284" r="118" className={styles.keyMintHalo} />
          <circle cx="688" cy="284" r="96" className={styles.keyMintRing} />
        </svg>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/step2-key.png"
          alt=""
          width={1024}
          height={1024}
          className={`${styles.layer} ${styles.s2Key}`}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/step2-ticks.png"
          alt=""
          width={1024}
          height={1024}
          className={`${styles.layer} ${styles.s2Ticks}`}
        />
      </div>
    );
  }

  return (
    <div
      className={`${styles.stage} ${styles.stage3} ${boosted ? styles.boosted : ""}`}
      onClick={triggerBoost}
      aria-hidden="true"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/landing/step3-shadow.png"
        alt=""
        width={1024}
        height={1024}
        className={`${styles.layer} ${styles.s3Shadow}`}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/landing/step3-bubble.png"
        alt=""
        width={1024}
        height={1024}
        className={`${styles.layer} ${styles.s3Bubble}`}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/landing/step3-arrow.png"
        alt=""
        width={1024}
        height={1024}
        className={`${styles.layer} ${styles.s3Arrow}`}
      />
      <svg viewBox="0 0 1024 1024" className={styles.overlaySvg}>
        <circle r="16" className={styles.signalOrb}>
          <animateMotion
            dur="2.4s"
            repeatCount="indefinite"
            path="M 584 532 Q 696 502 768 614"
          />
        </circle>
      </svg>

      <div className={styles.s3BotRig}>
        <svg viewBox="0 0 1024 1024" className={styles.overlaySvg}>
          <rect
            x="706"
            y="678"
            width="138"
            height="124"
            rx="16"
            transform="rotate(3 775 740)"
            className={styles.s3CrtGlow}
          />
          <g className={styles.s3EqGroup}>
            <rect x="734" y="732" width="10" height="36" rx="4" className={`${styles.s3EqBar} ${styles.s3Eq1}`} />
            <rect x="752" y="714" width="10" height="54" rx="4" className={`${styles.s3EqBar} ${styles.s3Eq2}`} />
            <rect x="770" y="702" width="10" height="66" rx="4" className={`${styles.s3EqBar} ${styles.s3Eq3}`} />
            <rect x="788" y="718" width="10" height="50" rx="4" className={`${styles.s3EqBar} ${styles.s3Eq4}`} />
            <rect x="806" y="730" width="10" height="38" rx="4" className={`${styles.s3EqBar} ${styles.s3Eq5}`} />
          </g>
        </svg>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/step3-bot.png"
          alt=""
          width={1024}
          height={1024}
          className={styles.layer}
        />
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/landing/step3-star.png"
          alt=""
          width={1024}
          height={1024}
          className={`${styles.layer} ${styles.s3Star}`}
        />
      </div>
    </div>
  );
}
