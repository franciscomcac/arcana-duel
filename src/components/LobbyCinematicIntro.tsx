import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { ArrowRight, Sparkles, Swords } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import './LobbyCinematicIntro.css';

type LobbyCinematicIntroProps = {
  active?: boolean;
  onComplete?: () => void;
  onSkip?: () => void;
};

const INTRO_DURATION = 5200;

export function LobbyCinematicIntro({ active = true, onComplete, onSkip }: LobbyCinematicIntroProps) {
  const prefersReducedMotion = useReducedMotion();
  const [visible, setVisible] = useState(active);
  const particles = useMemo(
    () =>
      Array.from({ length: 24 }, (_, index) => ({
        id: index,
        left: `${(index * 37 + 9) % 100}%`,
        top: `${(index * 61 + 17) % 100}%`,
        delay: `${(index % 8) * 0.16}s`,
        duration: `${3.5 + (index % 5) * 0.8}s`,
        size: `${1 + (index % 3)}px`,
      })),
    [],
  );

  useEffect(() => setVisible(active), [active]);

  useEffect(() => {
    if (!visible || prefersReducedMotion) return undefined;
    const timeout = window.setTimeout(() => {
      setVisible(false);
      onComplete?.();
    }, INTRO_DURATION);
    return () => window.clearTimeout(timeout);
  }, [onComplete, prefersReducedMotion, visible]);

  const dismiss = () => {
    setVisible(false);
    onSkip?.();
    onComplete?.();
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className="lobby-intro"
          initial={prefersReducedMotion ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { opacity: 0, transition: { duration: 0.45 } }}
          role="dialog"
          aria-label="Arcana Duel opening"
          aria-modal="true"
        >
          <div className="lobby-intro__backdrop" aria-hidden="true" />
          <div className="lobby-intro__grain" aria-hidden="true" />
          <div className="lobby-intro__particles" aria-hidden="true">
            {particles.map((particle) => (
              <span
                key={particle.id}
                className="lobby-intro__particle"
                style={{
                  left: particle.left,
                  top: particle.top,
                  width: particle.size,
                  height: particle.size,
                  animationDelay: particle.delay,
                  animationDuration: particle.duration,
                }}
              />
            ))}
          </div>

          <button className="lobby-intro__skip" type="button" onClick={dismiss} aria-label="Skip opening animation">
            Skip intro <ArrowRight size={14} aria-hidden="true" />
          </button>

          <div className="lobby-intro__stage">
            <motion.div
              className="lobby-intro__halo"
              initial={prefersReducedMotion ? false : { opacity: 0, scale: 0.55, rotate: -18 }}
              animate={{ opacity: 1, scale: 1, rotate: 0 }}
              transition={{ duration: 1.3, ease: [0.16, 1, 0.3, 1] }}
              aria-hidden="true"
            >
              <span className="lobby-intro__halo-ring lobby-intro__halo-ring--outer" />
              <span className="lobby-intro__halo-ring lobby-intro__halo-ring--inner" />
              <span className="lobby-intro__glyph"><Sparkles size={26} strokeWidth={1.35} /></span>
            </motion.div>

            <motion.div
              className="lobby-intro__cards"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 36, scale: 0.8 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: 0.45, duration: 1.2, ease: [0.16, 1, 0.3, 1] }}
              aria-hidden="true"
            >
              <span className="lobby-intro__card lobby-intro__card--left" />
              <span className="lobby-intro__card lobby-intro__card--center" />
              <span className="lobby-intro__card lobby-intro__card--right" />
            </motion.div>

            <motion.div
              className="lobby-intro__copy"
              initial={prefersReducedMotion ? false : { opacity: 0, y: 22 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 1.05, duration: 0.8, ease: 'easeOut' }}
            >
              <div className="lobby-intro__eyebrow"><Swords size={13} aria-hidden="true" /> LIVE ARENA</div>
              <h1>Arcana Duel</h1>
              <p>Every spell starts a story.</p>
              <div className="lobby-intro__rule" aria-hidden="true" />
              <span className="lobby-intro__subline">The battlefield is waiting</span>
            </motion.div>
          </div>

          <motion.div
            className="lobby-intro__footer"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.9, duration: 0.8 }}
          >
            <span>PLANESWALKER NETWORK</span>
            <span className="lobby-intro__footer-dot" aria-hidden="true" />
            <span>SEASON 01</span>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export default LobbyCinematicIntro;
