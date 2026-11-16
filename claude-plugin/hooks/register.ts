import type { Register } from 'claude-code'

// Agent Dock's Claude Code plugin. The dock replaces __AGENT_DOCK_CHANNEL_JSON__ with the absolute path of its
// channel folder when it installs this plugin. A hooks module: no Node imports, no new Claude process.
//
// What it does, and nothing else:
//  - every 5 s it writes "I am session <id>" into <channel>/sessions/<id>.json, so the dock knows it can answer here;
//  - every second it looks in <channel>/prompts/<id>/ for answers the user clicked in the dock, and submits each one
//    as the user's next message once the session is idle.
const CHANNEL = __AGENT_DOCK_CHANNEL_JSON__
const POLL_MS = 1000
const CHECK_IN_EVERY = 5
const MAX_TEXT = 2000

// Defence in depth: the dock already refuses these.
const acceptable = (text: unknown): text is string =>
  typeof text === 'string' && text.trim().length > 0 && text.length <= MAX_TEXT && !/^\s*[\/!#]/.test(text) && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(text)

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const { version } = await $.session.version()
    let busy = false
    let ticks = 0
    let last = ''
    $.clock.every(POLL_MS, () => {
      if (busy) return
      busy = true
      void (async () => {
        try {
          // /clear and resume can change the id without another session.start.
          const id = await $.session.id()
          if (ticks++ % CHECK_IN_EVERY === 0 || id !== last) {
            last = id
            await $.fs.write(`${CHANNEL}/sessions/${id}.json`, JSON.stringify({ at: await $.clock.now(), version, channelVersion: 1 }))
          }
          const folder = `${CHANNEL}/prompts/${id}`
          if (!(await $.fs.exists(folder))) return
          const entries = (await $.fs.list(folder)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
          const waiting: { path: string, cancel: string, prompt: Record<string, unknown> }[] = []
          for (const entry of entries) {
            const path = `${folder}/${entry.name}`
            let prompt: Record<string, unknown>
            try { prompt = JSON.parse(await $.fs.read(path)) } catch { continue }
            if (typeof prompt.text !== 'string') continue
            if (['takenAt', 'cancelledAt', 'expiredAt', 'refused'].some(k => prompt[k] !== undefined)) continue
            waiting.push({ path, cancel: path.slice(0, -5) + '.cancel', prompt })
          }
          waiting.sort((a, b) => Number(a.prompt.at) - Number(b.prompt.at))
          for (const { path, cancel, prompt } of waiting) {
            const now = await $.clock.now()
            const settle = async (what: Record<string, unknown>) => { try { await $.fs.write(path, JSON.stringify({ ...prompt, ...what })) } catch {} }
            if (await $.fs.exists(cancel)) { await settle({ cancelledAt: now }); continue }
            if (typeof prompt.expiresAt === 'number' && prompt.expiresAt <= now) { await settle({ expiredAt: now }); continue }
            if (!acceptable(prompt.text)) { await settle({ refused: 'The text is not acceptable' }); continue }
            // Claim before submitting, so a reload never submits one twice.
            await settle({ takenAt: now })
            if (await $.fs.exists(cancel)) { await settle({ takenAt: now, cancelledAt: await $.clock.now() }); continue }
            // asUser: the model reads it as the person's own words. The submit waits for the session to be idle;
            // never await it here, or the check-ins would stop.
            void $.prompt.submit({ text: prompt.text, asUser: true }).then(
              async result => {
                const dropped = (result as { drop?: unknown }).drop
                await settle(dropped === undefined ? { takenAt: now, startedAt: await $.clock.now() } : { takenAt: now, refused: String(dropped) })
              },
              async error => { await settle({ takenAt: now, refused: String(error) }) },
            )
          }
        } catch {
          // One failed pass retries on the next tick.
        } finally { busy = false }
      })()
    })
    return started
  })
  on('session.end', async ($, e, next) => {
    try { await $.fs.write(`${CHANNEL}/sessions/${e.sessionId}.json`, JSON.stringify({ ended: await $.clock.now() })) } catch {}
    return next(e)
  })
}
