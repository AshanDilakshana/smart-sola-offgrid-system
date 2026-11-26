import { useEffect, useRef, useState } from 'react';

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  window.matchMedia &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);

/**
 * Smoothly tweens a numeric value whenever it changes.
 * Returns the in-flight number (not formatted).
 */
export default function useAnimatedNumber(target, duration = 700) {
  const safeTarget = Number.isFinite(target) ? target : 0;
  const [value, setValue] = useState(safeTarget);
  const fromRef = useRef(safeTarget);
  const rafRef = useRef(0);

  useEffect(() => {
    if (prefersReducedMotion()) {
      fromRef.current = safeTarget;
      setValue(safeTarget);
      return undefined;
    }
    const from = fromRef.current;
    if (from === safeTarget) return undefined;
    const start = performance.now();

    const tick = (now) => {
      const p = Math.min(1, (now - start) / duration);
      const next = from + (safeTarget - from) * easeOutCubic(p);
      fromRef.current = next;
      setValue(next);
      if (p < 1) rafRef.current = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [safeTarget, duration]);

  return value;
}

/** Convenience component: <AnimatedNumber value={13.42} decimals={2} /> */
export function AnimatedNumber({ value, decimals = 0, duration = 700 }) {
  const v = useAnimatedNumber(value, duration);
  return <>{v.toFixed(decimals)}</>;
}
