import { motion } from 'framer-motion'
import { Bell, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react'

export function Shop() {
  return (
    <motion.main className="shop-page" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="shop-art" aria-hidden="true">
        <motion.img src="/cards/questing-beast.jpg" alt="" initial={{ x: -30, rotate: -13 }} animate={{ x: 0, rotate: -8 }} transition={{ type: 'spring', stiffness: 120 }} />
        <motion.img src="/cards/embercleave.jpg" alt="" initial={{ y: 35 }} animate={{ y: 0 }} transition={{ type: 'spring', stiffness: 120, delay: .08 }} />
        <motion.img src="/cards/lightning-bolt.jpg" alt="" initial={{ x: 30, rotate: 13 }} animate={{ x: 0, rotate: 8 }} transition={{ type: 'spring', stiffness: 120, delay: .14 }} />
        <span className="shop-seal"><LockKeyhole /></span>
      </div>
      <div className="shop-copy">
        <span><Sparkles /> Coming soon</span>
        <h1>The Arcana Shop</h1>
        <p>Cosmetic playmats, sleeves, avatars, and match effects are being prepared. Cards remain available through the deck builder; there are no booster packs or pay-to-win card unlocks.</p>
        <button type="button" disabled><Bell /> Notify me at launch</button>
        <small><ShieldCheck /> Gameplay cards will not be sold through randomized packs.</small>
      </div>
    </motion.main>
  )
}
