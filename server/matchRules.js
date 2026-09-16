export const MATCH_PHASES = ['untap', 'upkeep', 'draw', 'main1', 'begin_combat', 'declare_attackers', 'declare_blockers', 'combat_damage', 'end_combat', 'main2', 'end', 'cleanup']

const clone = (state) => structuredClone(state)
const reject = (state, error) => ({ state, accepted: false, error })
const MAX_LOG_ENTRIES = 100
function pushLog(state, text) {
  state.log.push({ id: Date.now(), text })
  if (state.log.length > MAX_LOG_ENTRIES) state.log.splice(0, state.log.length - MAX_LOG_ENTRIES)
}

function isPermanent(card) {
  return ['land', 'creature', 'artifact', 'enchantment', 'planeswalker', 'battle'].includes(card.kind)
}

function resolveTop(state) {
  const item = state.stack.pop()
  if (!item) return
  const controller = state.players[item.controller]
  const opponent = state.players[item.controller === 0 ? 1 : 0]
  const card = item.card
  if (isPermanent(card)) controller.battlefield.push(card)
  else {
    const damage = Number(card.rules?.match(/deal(?:s)?\s+(\d+)\s+damage/i)?.[1] || (card.id === 'lightning-bolt' ? 3 : card.id === 'shock' ? 2 : 0))
    if (damage > 0) opponent.life = Math.max(0, opponent.life - damage)
    controller.graveyard.push(card)
  }
  pushLog(state, `${card.name} resolved.`)
}

function enterNextPhase(state) {
  const phaseIndex = MATCH_PHASES.indexOf(state.phase)
  if (phaseIndex < 0 || state.phase === 'cleanup') {
    state.turn += 1
    state.activePlayer = state.activePlayer === 0 ? 1 : 0
    state.phase = 'untap'
    const active = state.players[state.activePlayer]
    active.landsPlayedThisTurn = 0
    active.battlefield = active.battlefield.map((card) => ({ ...card, tapped: false }))
  } else state.phase = MATCH_PHASES[phaseIndex + 1]

  if (state.phase === 'draw') {
    const active = state.players[state.activePlayer]
    const drawn = active.library.shift()
    if (drawn) active.hand.push(drawn)
  }
  state.priorityPlayer = state.activePlayer
  pushLog(state, `Turn ${state.turn}: ${state.phase.replaceAll('_', ' ')}.`)
}

function finishIfLethal(state) {
  const living = state.players.filter((player) => player.life > 0)
  if (living.length === 1) state.winner = living[0].index
  if (living.length === 0) state.draw = true
}

export function applyRemoteMatchAction(currentState, playerIndex, type, payload = {}) {
  payload = payload && typeof payload === 'object' ? payload : {}
  const sourcePlayer = currentState.players[playerIndex]
  if (!sourcePlayer || currentState.winner !== undefined || currentState.draw) return reject(currentState, 'The match is over.')
  const state = clone(currentState)
  const player = state.players[playerIndex]
  const opponent = state.players[playerIndex === 0 ? 1 : 0]

  if (type === 'play') {
    if (state.priorityPlayer !== playerIndex) return reject(currentState, 'That player does not have priority.')
    const card = player.hand.find((item) => item.uid === payload.uid)
    if (!card) return reject(currentState, "That card is not in the player's hand.")
    const sorcerySpeed = card.kind !== 'instant'
    if (sorcerySpeed && (state.activePlayer !== playerIndex || !['main1', 'main2'].includes(state.phase) || state.stack.length)) {
      return reject(currentState, "That card requires an empty stack during the active player's main phase.")
    }
    if (card.kind === 'land' && (player.landsPlayedThisTurn >= 1 || !['main1', 'main2'].includes(state.phase) || state.stack.length)) {
      return reject(currentState, 'The land play is not legal.')
    }
    player.hand = player.hand.filter((item) => item.uid !== payload.uid)
    if (card.kind === 'land') {
      player.battlefield.push(card)
      player.landsPlayedThisTurn += 1
      pushLog(state, `${player.name} played ${card.name}.`)
    } else {
      state.stack.push({ id: `stack-${state.turn}-${Date.now()}-${state.stack.length}`, controller: playerIndex, card })
      pushLog(state, `${player.name} cast ${card.name}.`)
    }
    state.consecutivePasses = 0
  } else if (type === 'tap') {
    const card = player.battlefield.find((item) => item.uid === payload.uid)
    if (!card) return reject(currentState, 'That permanent is not controlled by the player.')
    player.battlefield = player.battlefield.map((item) => item.uid === payload.uid ? { ...item, tapped: !item.tapped } : item)
  } else if (type === 'life') {
    const delta = Math.max(-20, Math.min(20, Number(payload.delta) || 0))
    player.life = Math.max(0, Math.min(99, player.life + delta))
  } else if (type === 'pass') {
    if (state.priorityPlayer !== playerIndex) return reject(currentState, 'That player does not have priority.')
    state.consecutivePasses += 1
    pushLog(state, `${player.name} passed priority.`)
    if (state.consecutivePasses >= state.players.length) {
      state.consecutivePasses = 0
      if (state.stack.length) resolveTop(state)
      else enterNextPhase(state)
      state.priorityPlayer = state.activePlayer
    } else state.priorityPlayer = opponent.index
  } else if (type === 'end') {
    if (state.activePlayer !== playerIndex) return reject(currentState, 'Only the active player can end the turn.')
    state.activePlayer = opponent.index
    state.priorityPlayer = opponent.index
    state.consecutivePasses = 0
    state.turn += 1
    state.phase = 'untap'
    opponent.landsPlayedThisTurn = 0
    opponent.battlefield = opponent.battlefield.map((card) => ({ ...card, tapped: false }))
    pushLog(state, `${opponent.name} begins turn ${state.turn}.`)
  } else return reject(currentState, 'Unknown match action.')

  finishIfLethal(state)
  return { state, accepted: true }
}
