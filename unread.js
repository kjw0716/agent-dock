'use strict';
// "Unread": an agent finished while the dock was watching, and you have not looked at it yet.
//
// A session becomes unread when it goes from working or waiting to done. It stops being unread
// when you click its row in the dock, when the session starts working again (you replied), or when
// it disappears. A session that was already done when the dock started is not unread: there is no
// way to know whether you saw it.
const keyOf = (s) => `${s.agent}:${s.id}`;

class UnreadTracker {
  /** `initial`: keys remembered from the last run; they survive only while the session is still done. */
  constructor(initial = []) {
    this.prev = new Map(); // key -> last state seen
    this.workStart = new Map(); // key -> when it started working (or waiting)
    this.unread = new Set();
    this.initial = new Set(initial);
  }

  /**
   * Feed the current sessions (every agent). Returns true when the unread set changed.
   * `minWork(agent)`: how long it must have been busy before finishing counts as unread, in ms; it
   * keeps agents whose working state is only a guess from flapping into "unread" every few seconds.
   */
  update(sessions, now = Date.now(), minWork = () => 0) {
    const before = this.unread.size + [...this.unread].join('|');
    const seen = new Set();
    for (const s of sessions) {
      const key = keyOf(s);
      seen.add(key);
      const prev = this.prev.get(key);
      if (s.state !== 'done') {
        this.unread.delete(key);
        if (!this.workStart.has(key)) this.workStart.set(key, now);
      } else if (prev === 'working' || prev === 'waiting') {
        if (now - (this.workStart.get(key) ?? now) >= minWork(s.agent)) this.unread.add(key);
        this.workStart.delete(key);
      } else if (prev === undefined && this.initial.has(key)) {
        this.unread.add(key); // it was unread before the dock restarted and is still done
      }
      if (s.state === 'done') this.workStart.delete(key);
      this.prev.set(key, s.state);
    }
    for (const key of [...this.prev.keys()]) {
      if (!seen.has(key)) {
        this.prev.delete(key);
        this.workStart.delete(key);
        this.unread.delete(key);
      }
    }
    this.initial.clear(); // only the first update looks at what was remembered
    return this.unread.size + [...this.unread].join('|') !== before;
  }

  has(session) {
    return this.unread.has(keyOf(session));
  }

  /** Mark every session of an agent read (a click on its row). Returns true when something was unread. */
  readAgent(agentId) {
    let any = false;
    for (const key of [...this.unread]) {
      if (key.startsWith(`${agentId}:`)) {
        this.unread.delete(key);
        any = true;
      }
    }
    return any;
  }

  list() {
    return [...this.unread].sort();
  }
}

module.exports = { UnreadTracker, keyOf };
