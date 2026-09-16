import { AnimatePresence, motion, useMotionValue, useReducedMotion, useSpring, useTransform } from 'framer-motion'
import { ImageOff, Maximize2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CatalogCard } from './catalog'

export function CardPeek({ card, onOpen }: { card: CatalogCard | null; onOpen: () => void }) {
  return (
    <AnimatePresence mode="wait">
      {card && (
        <motion.aside key={card.id} className="card-peek" initial={{ opacity: 0, x: 18, scale: .97 }} animate={{ opacity: 1, x: 0, scale: 1 }} exit={{ opacity: 0, x: 12 }}>
          <button type="button" className="peek-art" onClick={onOpen} aria-label={`Zoom ${card.name}`}>
            <img src={card.image} alt={card.name} />
            <span><Maximize2 size={15} /> Zoom card</span>
          </button>
          <div className="peek-copy"><b>{card.name}</b><small>{card.typeLine}</small><p>{card.rules || 'No rules text.'}</p></div>
        </motion.aside>
      )}
    </AnimatePresence>
  )
}

export function CardZoom({ card, onClose }: { card: CatalogCard | null; onClose: () => void }) {
  const pointerX = useMotionValue(0)
  const pointerY = useMotionValue(0)
  const reduceMotion = useReducedMotion()
  const [imageFailed, setImageFailed] = useState(false)
  const rotateY = useSpring(useTransform(pointerX, [-1, 1], [-7, 7]), { stiffness: 180, damping: 22 })
  const rotateX = useSpring(useTransform(pointerY, [-1, 1], [6, -6]), { stiffness: 180, damping: 22 })
  const sheenX = useTransform(pointerX, [-1, 1], ['-40%', '40%'])

  useEffect(() => setImageFailed(false), [card?.image])

  useEffect(() => {
    if (!card) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [card, onClose])

  return (
    <AnimatePresence>
      {card && (
        <motion.div className="zoom-backdrop" role="dialog" aria-modal="true" aria-label={`${card.name} card details`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose}>
          <button type="button" className="zoom-close" onClick={onClose} aria-label="Close card zoom"><X size={20} /></button>
          <motion.div
            className="zoom-card-stage"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: .72, y: 80, rotateZ: -5 }}
            animate={{ opacity: 1, scale: 1, y: 0, rotateZ: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: .82, y: 45 }}
            transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 260, damping: 24 }}
            style={{ rotateX: reduceMotion ? 0 : rotateX, rotateY: reduceMotion ? 0 : rotateY, transformPerspective: 900 }}
            onClick={(event) => event.stopPropagation()}
            onPointerMove={(event) => {
              if (reduceMotion) return
              const rect = event.currentTarget.getBoundingClientRect()
              pointerX.set(((event.clientX - rect.left) / rect.width) * 2 - 1)
              pointerY.set(((event.clientY - rect.top) / rect.height) * 2 - 1)
            }}
            onPointerLeave={() => { pointerX.set(0); pointerY.set(0) }}
          >
            {!imageFailed && <img src={card.image} alt={card.name} onError={() => setImageFailed(true)} />}
            {imageFailed && <div className="zoom-image-fallback"><ImageOff size={34} /><b>{card.name}</b><small>{card.typeLine}</small></div>}
            {!reduceMotion && <motion.div className="foil-sheen" style={{ x: sheenX }} />}
          </motion.div>
          <motion.div className="zoom-details" initial={reduceMotion ? { opacity: 0 } : { opacity: 0, x: 28 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: reduceMotion ? 0 : .12 }} onClick={(event) => event.stopPropagation()}>
            <span className={`rarity ${card.rarity.toLowerCase()}`}>{card.rarity}</span>
            <h2>{card.name}</h2>
            <small>{card.typeLine}</small>
            <p>{card.rules || 'No rules text.'}</p>
            {card.power !== undefined && <b className="zoom-stats">{card.power} / {card.toughness}</b>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
