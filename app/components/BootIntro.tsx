"use client";

import { useEffect, useRef, useState } from "react";
import { LandingJellyfish } from "./LandingJellyfish";

type BootIntroProps = {
  onActiveChange: (active: boolean) => void;
};

const INTRO_DURATION_MS = 1_100;
const REMOVE_DELAY_MS = 420;

/**
 * A compact brand entrance, not a video splash. It is deliberately local to a
 * navigation: closing the site and coming back should feel welcoming again,
 * while reduced-motion users see no forced transition. `pageshow` covers a
 * browser history return restored from the back/forward cache.
 */
export function BootIntro({ onActiveChange }: BootIntroProps) {
  // Render the opaque overlay on the server and on the first client paint.
  // Starting at `false` meant the landing page painted for one hydration frame
  // before the effect could mount the intro — a visible, amateur flash.
  const [visible, setVisible] = useState(true);
  const [revealing, setRevealing] = useState(false);
  const [showSkip, setShowSkip] = useState(false);
  const revealStarted = useRef(false);
  /** The effect owns the intro's timers, so `beginReveal` has to be declared
   *  inside it. The Skip button lives in JSX, outside that scope — this ref is
   *  the handoff. Without it the button referenced a name that does not exist
   *  where it is used, which does not compile. */
  const dismissRef = useRef<() => void>(() => {});

  useEffect(() => {
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let revealTimer = 0;
    let skipTimer = 0;
    let finishTimer = 0;

    const beginReveal = () => {
      if (revealStarted.current) return;
      revealStarted.current = true;
      window.clearTimeout(revealTimer);
      window.clearTimeout(skipTimer);
      setRevealing(true);
      onActiveChange(false);
      finishTimer = window.setTimeout(() => setVisible(false), REMOVE_DELAY_MS);
    };

    const startIntro = () => {
      window.clearTimeout(revealTimer);
      window.clearTimeout(skipTimer);
      window.clearTimeout(finishTimer);
      revealStarted.current = false;
      setRevealing(false);
      setShowSkip(false);

      if (reducedMotion) {
        setVisible(false);
        onActiveChange(false);
        return;
      }

      setVisible(true);
      onActiveChange(true);
      revealTimer = window.setTimeout(beginReveal, INTRO_DURATION_MS);
      skipTimer = window.setTimeout(() => setShowSkip(true), 700);
    };

    const dismissOnIntent = () => beginReveal();
    dismissRef.current = dismissOnIntent;
    const replayOnHistoryReturn = (event: PageTransitionEvent) => {
      if (event.persisted) startIntro();
    };

    startIntro();
    window.addEventListener("keydown", dismissOnIntent);
    window.addEventListener("pointerdown", dismissOnIntent);
    window.addEventListener("pageshow", replayOnHistoryReturn);
    return () => {
      window.clearTimeout(revealTimer);
      window.clearTimeout(skipTimer);
      window.clearTimeout(finishTimer);
      window.removeEventListener("keydown", dismissOnIntent);
      window.removeEventListener("pointerdown", dismissOnIntent);
      window.removeEventListener("pageshow", replayOnHistoryReturn);
    };
  }, [onActiveChange]);

  if (!visible) return null;

  return (
      <div className={revealing ? "bootIntro revealing" : "bootIntro"} aria-hidden={revealing} role="status" aria-label="Loading Trion workspace">
      <div className="bootShader" aria-hidden="true" />
      <div className="bootCurrent bootCurrentOne" aria-hidden="true" />
      <div className="bootCurrent bootCurrentTwo" aria-hidden="true" />
      <div className="bootBrand">
        <div className="bootMark"><LandingJellyfish size={104} title="Nomin" /></div>
        <p className="bootWordmark nominWordmark">Nomin</p>
        <p className="bootTagline">Coding agent</p>
      </div>
      {showSkip ? (
        <button className="bootSkip" onClick={() => dismissRef.current()} type="button">
          Continue to Trion
        </button>
      ) : null}
    </div>
  );
}
