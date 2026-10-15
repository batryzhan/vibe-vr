/**
 * One client's view of one session's event log: replay what it missed, then tail.
 *
 * **Subscribe first, then read.** The obvious order — read the history, then start
 * listening — loses everything appended in between, which is precisely the window a client
 * connecting mid-turn lands in. So this subscribes, buffers whatever arrives, awaits the
 * history, sends it, flushes the buffer, and only then goes live. The flush is synchronous
 * and the bus delivers synchronously, so nothing can interleave with it; the read is the
 * only await in the whole opening sequence.
 *
 * **Nothing is sent twice.** Every outbound event passes one gate on the highest `seq`
 * already sent, so "the replay and the buffer overlap" needs no special case and a
 * republished event cannot become a doubled message in someone's chat.
 *
 * Deliberately knows nothing about WebSockets: it is given something that can `send` text
 * and `close`, which both a test double and Hono's `WSContext` satisfy. The socket is the
 * part that cannot run under Node, and keeping it out of here is what lets the replay
 * ordering be tested at all.
 */

import type { EventBus, Unsubscribe } from "@vibe-vr/shared/ports/event-bus";
import type { EventStore, StoredEvent } from "@vibe-vr/shared/ports/event-store";
import { parseClientFrame, type ServerFrame, WS_CLOSE } from "@vibe-vr/shared/ws-protocol";
import type { TurnState } from "../turns/state-machine.ts";

/**
 * Real-time event contract emitted for every state transition and gate outcome in the
 * multi-model pipeline. Delivered directly over the WebSocket to inform the frontend
 * viewport and UI of live step progression, clarification requests, and commits.
 */
export type TurnStreamEvent =
  | { type: "turn.state_changed"; turnId: string; from: TurnState; to: TurnState; timestamp: string }
  | { type: "turn.needs_input"; turnId: string; ambiguityReason: string; questions: string[] }
  | { type: "turn.plan_ready"; turnId: string; sceneSummary: string; totalSteps: number; steps: Array<{ stepId: string; goal: string }> }
  | { type: "turn.step_started"; turnId: string; stepIndex: number; stepId: string; attempt: number; model: string }
  | { type: "turn.gate_result"; turnId: string; stepId: string; attempt: number; gate: 1 | 2 | 3; passed: boolean; diagnostics?: string }
  | { type: "turn.step_committed"; turnId: string; stepIndex: number; stepId: string; newRevision: number; sceneDelta: unknown }
  | { type: "turn.stale_rebase"; turnId: string; expectedRevision: number; actualRevision: number; rebaseAttempt: number }
  | { type: "turn.completed"; turnId: string; finalRevision: number }
  | { type: "turn.failed"; turnId: string; stepId?: string; reason: string };

export type TurnStreamListener = (event: TurnStreamEvent) => void;

/**
 * Pub/sub bus for turn pipeline real-time stream events, keyed by session ID.
 */
export class TurnStreamBus {
  readonly #subscribers = new Map<string, Set<TurnStreamListener>>();

  subscribe(sessionId: string, listener: TurnStreamListener): () => void {
    let set = this.#subscribers.get(sessionId);
    if (!set) {
      set = new Set();
      this.#subscribers.set(sessionId, set);
    }
    set.add(listener);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.#subscribers.delete(sessionId);
    };
  }

  broadcast(sessionId: string, event: TurnStreamEvent): void {
    const set = this.#subscribers.get(sessionId);
    if (!set) return;
    for (const listener of set) {
      listener(event);
    }
  }

  get subscriberCount(): number {
    let total = 0;
    for (const set of this.#subscribers.values()) total += set.size;
    return total;
  }
}

export const globalTurnStreamBus = new TurnStreamBus();

/**
 * Global helper to broadcast a TurnStreamEvent to all active WebSockets watching a session.
 */
export function broadcastTurnEvent(sessionId: string, event: TurnStreamEvent): void {
  globalTurnStreamBus.broadcast(sessionId, event);
}

/** The two things this needs from a socket. */
export type StreamSocket = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
};

export type HeartbeatOptions = {
  /** How often to ping, and the granularity at which silence is measured. */
  intervalMs: number;
  /** Silence longer than this closes the connection. */
  timeoutMs: number;
};

/**
 * A dead TCP connection can stay open for minutes; a ping every 30 seconds finds it in one,
 * and a client that has answered nothing for two and a half minutes is gone.
 */
export const DEFAULT_HEARTBEAT: HeartbeatOptions = { intervalMs: 30_000, timeoutMs: 150_000 };

export type EventStreamOptions = {
  store: EventStore;
  bus: EventBus;
  sessionId: string;
  /** Send events after this sequence number. */
  afterSeq: number;
  socket: StreamSocket;
  heartbeat?: HeartbeatOptions;
  turnBus?: TurnStreamBus;
};

export type EventStream = {
  /** Hand it whatever the client sent, text or not. */
  onMessage(raw: unknown): void;
  /** Releases the subscription and the heartbeat. Safe to call more than once. */
  onClose(): void;
  /** Directly send a TurnStreamEvent over the connected socket. */
  sendTurnEvent(event: TurnStreamEvent): void;
  /** Resolves once the replay has been delivered. Tests await it; the socket does not. */
  ready: Promise<void>;
};

export function openEventStream(options: EventStreamOptions): EventStream {

  const { store, bus, sessionId, afterSeq, socket } = options;
  const heartbeat = options.heartbeat ?? DEFAULT_HEARTBEAT;

  let lastSentSeq = afterSeq;
  let sentAnything = false;
  let closed = false;
  let replaying = true;
  const buffered: StoredEvent[] = [];
  let silentIntervals = 0;

  const send = (frame: ServerFrame): void => {
    if (closed) return;
    socket.send(JSON.stringify(frame));
  };

  const sendEvent = (event: StoredEvent): void => {
    // The one gate that makes "no duplicates" structural rather than a rule each path has
    // to remember. Ordering is guaranteed by seq being gapless per session.
    //
    // The first event is never gated, because a client cannot have seen an event that does
    // not exist: one that asks for a seq past the end of the log — a stale reconnect, or a
    // reset database — would otherwise be silenced for the life of the connection, which
    // looks exactly like a working stream with nothing happening.
    if (sentAnything && event.seq <= lastSentSeq) return;
    sentAnything = true;
    lastSentSeq = event.seq;
    send({ type: "event", event });
  };

  const unsubscribe: Unsubscribe = bus.subscribe(sessionId, (event) => {
    if (closed) return;
    if (replaying) {
      buffered.push(event);
      return;
    }
    sendEvent(event);
  });

  const turnBus = options.turnBus ?? globalTurnStreamBus;
  const unsubscribeTurn = turnBus.subscribe(sessionId, (turnEvent) => {
    if (closed) return;
    send(turnEvent);
  });

  const timer = setInterval(() => {
    if (closed) return;
    silentIntervals += 1;
    if (silentIntervals * heartbeat.intervalMs >= heartbeat.timeoutMs) {
      shutdown();
      socket.close(WS_CLOSE.heartbeatTimeout, "no frames received");
      return;
    }
    send({ type: "ping" });
  }, heartbeat.intervalMs);

  function shutdown(): void {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    unsubscribe();
    unsubscribeTurn();
  }

  const ready = (async () => {
    const history = await store.readFrom(sessionId, afterSeq);
    if (closed) return;

    for (const event of history) sendEvent(event);
    // Anything the turn produced while that query was in flight. Synchronous, so no event
    // can arrive between the last flushed one and going live.
    for (const event of buffered) sendEvent(event);
    buffered.length = 0;
    replaying = false;

    // Only now, because "ready" means the client has everything up to this moment — including
    // whatever was appended while the history query was in flight. Announced at all because
    // "connected and nothing has arrived" is otherwise two different situations wearing one
    // face: a conversation still on its way, and a project nobody has typed into yet.
    send({ type: "ready" });
  })();

  return {
    ready,
    onClose: shutdown,
    sendTurnEvent(event: TurnStreamEvent): void {
      send(event);
    },
    onMessage(raw: unknown): void {
      if (closed) return;
      // Any frame at all proves the client is alive — waiting specifically for a pong would
      // close a connection whose client is chatty but never answers the heartbeat.
      silentIntervals = 0;

      const frame = parseClientFrame(raw);
      // Advisory, not fatal: a client bug should cost it an error frame, not its transcript.
      if (!frame.ok) send({ type: "error", message: frame.error.message });
    },
  };
}

