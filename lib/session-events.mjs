// Bounded in-memory delivery state. No credentials, filesystem or host services.
export function eventTime(event, fallback = Date.now()) {
  return typeof event?.time === 'number' && Number.isFinite(event.time) && event.time >= 0
    ? event.time : fallback
}

export function createCompletionFeed({ streamId, initialSeq = 0, limit = 128, onSequence = () => {} }) {
  let seq = Number.isSafeInteger(initialSeq) && initialSeq >= 0 ? initialSeq : 0
  const capacity = Math.max(1, Math.min(1024, Math.floor(limit) || 128))
  const entries = []
  const completed = new Map()
  return {
    get seq() { return seq },
    has(sessionId, turn) { return completed.get(sessionId) >= turn },
    publish(event) {
      if (!event.sessionId || !Number.isSafeInteger(event.turn) || event.turn < 0) return null
      if (completed.get(event.sessionId) >= event.turn) return null
      completed.delete(event.sessionId)
      completed.set(event.sessionId, event.turn)
      while (completed.size > 1024) completed.delete(completed.keys().next().value)
      const entry = Object.freeze({ ...event, seq: ++seq, eventId: streamId + ':' + seq })
      entries.push(entry)
      if (entries.length > capacity) entries.shift()
      onSequence(seq)
      return entry
    },
    read(after, requestedStream) {
      const cursor = typeof after === 'number' ? after : (/^\d+$/.test(String(after)) ? Number(after) : NaN)
      const reset = requestedStream !== streamId || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > seq
      return {
        streamId, cursor: seq, reset,
        gap: !reset && entries.length > 0 && cursor < entries[0].seq - 1,
        events: reset ? [] : entries.filter(entry => entry.seq > cursor),
      }
    },
  }
}

export function createPendingWaits({ limit = 256 } = {}) {
  const pending = new Map()
  const titles = new Map()
  const turns = new Map()
  const sequences = new Map()
  const capacity = Math.max(1, Math.min(1024, Math.floor(limit) || 256))
  const callId = event => {
    const data = event?.data || {}
    const message = data.message || {}
    for (const part of Array.isArray(message.content) ? message.content : []) {
      if (part && (part.toolCallId || part.tool_call_id)) return String(part.toolCallId || part.tool_call_id)
    }
    return String(message.callId || message.toolCallId || message.tool_call_id || data.callId || data.call_id || data.toolCallId || data.id || '')
  }
  const remove = (sessionId, kind, id) => {
    for (const [key, item] of pending) {
      if (item.session !== sessionId || (kind && item.kind !== kind) || (id && item.id !== id)) continue
      pending.delete(key)
    }
  }
  return {
    dispose(sessionId) { remove(sessionId); titles.delete(sessionId); turns.delete(sessionId); sequences.delete(sessionId) },
    update(sessionId, event, context = {}) {
      if (!sessionId || !event) return
      const type = event.type
      const data = event.data || {}
      if (Number.isSafeInteger(event.seq)) {
        if (sequences.has(sessionId) && event.seq <= sequences.get(sessionId)) return
        sequences.delete(sessionId)
        sequences.set(sessionId, event.seq)
        while (sequences.size > 1024) sequences.delete(sequences.keys().next().value)
      }
      if (Number.isSafeInteger(data.turn)) {
        if (turns.has(sessionId) && data.turn < turns.get(sessionId)) return
        turns.delete(sessionId)
        turns.set(sessionId, data.turn)
        while (turns.size > 1024) turns.delete(turns.keys().next().value)
      }
      const title = type === 'session/title' ? String(data.title || '').trim() : String(context.sessionName || '').trim()
      if (title) {
        titles.delete(sessionId)
        titles.set(sessionId, title.slice(0, 120))
        while (titles.size > 1024) titles.delete(titles.keys().next().value)
      }
      if (title) for (const item of pending.values()) {
        if (item.session === sessionId) item.sessionName = title.slice(0, 120)
      }
      let kind = ''
      if (type === 'tool/call' && String(data.name || data.toolName || '') === 'ask_user_question') kind = 'question'
      if (type === 'approval/asked') kind = 'approval'
      if (kind) {
        const id = (kind === 'approval' ? String(data.id || '') : callId(event)) || (kind + ':' + (event.seq ?? eventTime(event)))
        const key = JSON.stringify([sessionId, kind, id])
        // A repeated host event must not move the same request to the front.
        if (!pending.has(key)) pending.set(key, {
          kind, id, ts: eventTime(event), session: sessionId, turn: turns.get(sessionId) ?? null,
          sessionName: titles.get(sessionId) || '', workspace: typeof context.workspace === 'string' ? context.workspace : '',
        })
        while (pending.size > capacity) pending.delete(pending.keys().next().value)
        return
      }
      if (type === 'tool/result') {
        const id = callId(event)
        if (id) remove(sessionId, 'question', id)
      } else if (type === 'approval/resolved' || type === 'approval/answered' || type === 'approval/decided' || type === 'approval/cancelled') {
        const id = String(data.id || '')
        if (id) remove(sessionId, 'approval', id)
      } else if (type === 'turn/start' || type === 'turn/end') {
        remove(sessionId)
      }
    },
    snapshot() {
      const items = Array.from(pending.values())
      const current = items.length ? { ...items[items.length - 1] } : null
      return { pending: current, sessionName: current?.sessionName || '', pendingCount: items.length }
    },
  }
}
