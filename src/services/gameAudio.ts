type SoundEvent =
  | 'ui'
  | 'draw'
  | 'land'
  | 'mana'
  | 'cast'
  | 'resolve'
  | 'attack'
  | 'block'
  | 'impact'
  | 'death'
  | 'turn'
  | 'victory'
  | 'defeat'

export class GameAudio {
  private context: AudioContext | null = null
  private master: GainNode | null = null
  private enabled = true
  private noiseBuffers = new Map<string, AudioBuffer>()

  setEnabled(enabled: boolean) {
    this.enabled = enabled
    if (enabled) void this.unlock()
  }

  async unlock() {
    if (!this.enabled) return
    if (!this.context) {
      this.context = new AudioContext()
      this.master = this.context.createGain()
      this.master.gain.value = 0.2
      this.master.connect(this.context.destination)
    }
    if (this.context.state === 'suspended') await this.context.resume()
  }

  play(event: SoundEvent) {
    if (!this.enabled) return
    void this.unlock().then(() => {
      const now = this.context!.currentTime
      const note = (frequency: number, offset: number, duration: number, volume: number, type: OscillatorType = 'sine', endFrequency = frequency) => {
        const oscillator = this.context!.createOscillator()
        const gain = this.context!.createGain()
        oscillator.type = type
        oscillator.frequency.setValueAtTime(frequency, now + offset)
        oscillator.frequency.exponentialRampToValueAtTime(Math.max(20, endFrequency), now + offset + duration)
        gain.gain.setValueAtTime(0.0001, now + offset)
        gain.gain.exponentialRampToValueAtTime(volume, now + offset + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + duration)
        oscillator.connect(gain).connect(this.master!)
        oscillator.start(now + offset)
        oscillator.stop(now + offset + duration + 0.02)
      }
      const noise = (offset: number, duration: number, volume: number, highpass = 500) => {
        const key = `${duration.toFixed(3)}:${this.context!.sampleRate}`
        let buffer = this.noiseBuffers.get(key)
        if (!buffer) {
          const length = Math.ceil(this.context!.sampleRate * duration)
          buffer = this.context!.createBuffer(1, length, this.context!.sampleRate)
          const data = buffer.getChannelData(0)
          for (let index = 0; index < length; index += 1) data[index] = Math.random() * 2 - 1
          this.noiseBuffers.set(key, buffer)
        }
        const source = this.context!.createBufferSource()
        const filter = this.context!.createBiquadFilter()
        const gain = this.context!.createGain()
        source.buffer = buffer
        filter.type = 'highpass'
        filter.frequency.value = highpass
        gain.gain.setValueAtTime(volume, now + offset)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + duration)
        source.connect(filter).connect(gain).connect(this.master!)
        source.start(now + offset)
      }

      switch (event) {
        case 'ui': note(520, 0, .07, .09, 'sine', 650); break
        case 'draw': noise(0, .14, .045, 1800); note(440, .03, .15, .08, 'triangle', 700); break
        case 'land': note(105, 0, .22, .16, 'sine', 72); noise(0, .12, .055, 180); break
        case 'mana': note(330, 0, .18, .09, 'sine', 660); note(495, .03, .2, .055, 'triangle', 880); break
        case 'cast': note(180, 0, .34, .1, 'sawtooth', 620); note(360, .05, .32, .08, 'sine', 920); noise(.08, .22, .035, 1400); break
        case 'resolve': note(740, 0, .18, .08, 'triangle', 370); note(555, .04, .25, .065, 'sine', 277); break
        case 'attack': note(150, 0, .16, .12, 'square', 90); noise(.02, .16, .07, 350); break
        case 'block': note(210, 0, .13, .1, 'square', 130); note(130, .08, .2, .11, 'sine', 70); break
        case 'impact': noise(0, .25, .15, 120); note(90, 0, .3, .18, 'sine', 42); note(170, .02, .12, .08, 'square', 65); break
        case 'death': note(260, 0, .42, .09, 'sawtooth', 55); noise(.1, .3, .055, 500); break
        case 'turn': [392, 494, 587].forEach((frequency, index) => note(frequency, index * .07, .22, .055, 'triangle')); break
        case 'victory': [392, 494, 587, 784].forEach((frequency, index) => note(frequency, index * .11, .42, .075, 'triangle')); break
        case 'defeat': [294, 247, 196, 147].forEach((frequency, index) => note(frequency, index * .12, .38, .07, 'sine')); break
      }
    })
  }
}

export function soundForGameEvent(type: string): SoundEvent | null {
  if (type === 'draw') return 'draw'
  if (type === 'play_land') return 'land'
  if (type === 'mana' || type === 'mana_ability') return 'mana'
  if (type === 'cast' || type === 'activate' || type === 'trigger') return 'cast'
  if (type === 'resolve' || type === 'counter') return 'resolve'
  if (type === 'attackers') return 'attack'
  if (type === 'blockers') return 'block'
  if (type === 'combat_damage' || type === 'first_strike_damage') return 'impact'
  if (type === 'creature_died') return 'death'
  if (type === 'phase') return 'turn'
  if (type === 'player_lost') return 'defeat'
  return null
}
