import { InMemoryEventBus } from "@vibe-vr/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@vibe-vr/db/testing/in-memory-event-store";
import { hashSceneSpec } from "@vibe-vr/scene-spec/revisions";
import { towerSpec } from "@vibe-vr/scene-spec/tower";
import type { NapEvent } from "@vibe-vr/shared/events";
import type { EventBus, EventHandler, Unsubscribe } from "@vibe-vr/shared/ports/event-bus";
import type {
  AppendOptions,
  EventStore,
  PendingEvent,
  StoredEvent,
} from "@vibe-vr/shared/ports/event-store";
import { type ServerFrame, ServerFrameSchema, WS_CLOSE } from "@vibe-vr/shared/ws-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openEventStream, TurnStreamBus, type TurnStreamEvent } from "./event-stream.ts";

/**
 * The whole streaming layer's correctness lives in this file, and none of it needs a socket:
 * replay, the seam between replay and live tail, the heartbeat and frame validation are all
 * properties of the connection object. What a real WebSocket adds — the upgrade, Bun's
 * dispatch — is what `bun run ws:smoke` covers, because Vitest runs under Node.
 */

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const OTHER_SESSION = "1c8f9f2e-4d3b-4e6c-8f7a-2b3c4d5e6f70";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

const HEARTBEAT = { intervalMs: 1000, timeoutMs: 2500 };

class FakeSocket {
  readonly sent: string[] = [];
  closed: { code: number | undefined; reason: string | undefined } | undefined;

  readonly send = (data: string): void => {
    if (this.closed !== undefined) throw new Error("sent a frame after the socket closed");
    this.sent.push(data);
  };

  readonly close = (code?: number, reason?: string): void => {
    this.closed = { code, reason };
  };

  /** Every frame, parsed — so a malformed one fails the test that produced it. */
  get frames(): ServerFrame[] {
    return this.sent.map((raw) => ServerFrameSchema.parse(JSON.parse(raw)));
  }

  get events(): NapEvent[] {
    return this.frames.flatMap((frame) => (frame.type === "event" ? [frame.event] : []));
  }

  get seqs(): number[] {
    return this.events.map((event) => event.seq);
  }

  frameTypes(): ServerFrame["type"][] {
    return this.frames.map((frame) => frame.type);
  }

  /**
   * Forgets everything sent so far.
   *
   * For the tests whose subject is what happens *after* the connection has opened: every
   * connection now ends its replay with a `ready` frame, and "nothing was sent" in those tests
   * has always meant "nothing was sent from here on".
   */
  clear(): void {
    this.sent.length = 0;
  }
}

function message(sessionId: string, text: string): PendingEvent {
  return {
    type: "agent.message",
    sessionId,
    turnId: TURN,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload: { text },
  };
}

/** Appends to the store and publishes on the bus — the order the runtime uses. */
async function emit(
  store: EventStore,
  bus: InMemoryEventBus,
  sessionId: string,
  text: string,
): Promise<StoredEvent> {
  const stored = await store.append(message(sessionId, text));
  bus.publish(stored);
  return stored;
}

/** Appends any pending event and publishes it — `emit` for non-chat events. */
async function emitEvent(
  store: EventStore,
  bus: InMemoryEventBus,
  event: PendingEvent,
): Promise<StoredEvent> {
  const stored = await store.append(event);
  bus.publish(stored);
  return stored;
}

const GENESIS_HASH = hashSceneSpec(towerSpec());

function widenedTower() {
  const spec = towerSpec();
  const base = spec.nodes.find((node) => node.id === "base");
  if (base?.kind !== "procedural" || base.op !== "box") throw new Error("fixture changed shape");
  base.params.width = 2.4;
  return spec;
}

const WIDE_HASH = hashSceneSpec(widenedTower());

function sceneUpdated(
  sessionId: string,
  spec: ReturnType<typeof towerSpec>,
  parentHash: string | null,
): PendingEvent {
  return {
    type: "scene.updated",
    sessionId,
    turnId: TURN,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload: { spec, parentHash, specHash: hashSceneSpec(spec) },
  };
}

function sceneRejected(sessionId: string, diagnostics: string): PendingEvent {
  return {
    type: "scene.rejected",
    sessionId,
    turnId: TURN,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload: { code: "stale_base", diagnostics },
  };
}

async function seed(store: EventStore, sessionId: string, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) await store.append(message(sessionId, `event ${i}`));
}

/**
 * A store that takes its snapshot immediately but does not hand it over until the test says
 * so — a slow query, in other words.
 *
 * The snapshot has to be taken *first*. A gate in front of the read would let events emitted
 * while it is held show up in the result, which is precisely the case that needs to be
 * excluded: what makes the ordering bug real is an event that the history query cannot
 * contain and the subscription is not yet open for.
 */
class SlowStore implements EventStore {
  #release: (() => void) | undefined;
  readonly #gate: Promise<void>;

  constructor(private readonly inner: EventStore) {
    this.#gate = new Promise<void>((resolve) => {
      this.#release = resolve;
    });
  }

  append(event: PendingEvent, options?: AppendOptions): Promise<StoredEvent> {
    return this.inner.append(event, options);
  }

  async readFrom(sessionId: string, afterSeq: number): Promise<StoredEvent[]> {
    const snapshot = await this.inner.readFrom(sessionId, afterSeq);
    await this.#gate;
    return snapshot;
  }

  release(): void {
    this.#release?.();
  }
}

/**
 * Counts live subscriptions, because "nothing was sent after close" does not prove the
 * subscription went away — a connection that merely ignores what it receives looks identical
 * from the socket's side, and leaks one subscriber per reconnect.
 */
class CountingBus implements EventBus {
  readonly #inner = new InMemoryEventBus();
  subscriptions = 0;

  publish(event: StoredEvent): void {
    this.#inner.publish(event);
  }

  subscribe(sessionId: string, handler: EventHandler): Unsubscribe {
    const unsubscribe = this.#inner.subscribe(sessionId, handler);
    this.subscriptions += 1;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.subscriptions -= 1;
      }
      unsubscribe();
    };
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("replay then tail", () => {
  it("replays exactly what follows the requested seq, then streams live", async () => {
    // The correctness heart of the streaming layer (docs/PLAN.md §4): a client that has
    // already seen five events must receive the other five and then the live tail, with no
    // duplicate and no gap.
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    await seed(store, SESSION, 10);
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 5, socket });
    await stream.ready;

    expect(socket.seqs).toEqual([6, 7, 8, 9, 10]);

    await emit(store, bus, SESSION, "live");

    expect(socket.seqs).toEqual([6, 7, 8, 9, 10, 11]);
    // `ready` sits exactly on the seam: everything the log held, then the announcement, then
    // the live tail. A client that trusted it earlier would call a half-delivered log complete.
    expect(socket.frameTypes()).toEqual([...Array(5).fill("event"), "ready", "event"]);
  });

  it("replays everything from seq 0", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    await seed(store, SESSION, 3);
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });
    await stream.ready;

    expect(socket.seqs).toEqual([1, 2, 3]);
  });

  it("sends nothing when the client is already ahead, and still tails", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    await seed(store, SESSION, 3);
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 99, socket });
    await stream.ready;
    // Nothing to replay — but a client that is already up to date still has to be told so, or
    // it waits for a log that has already been fully delivered.
    expect(socket.frameTypes()).toEqual(["ready"]);

    await emit(store, bus, SESSION, "live");
    expect(socket.seqs).toEqual([4]);
  });

  it("delivers nothing from another session", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    await seed(store, OTHER_SESSION, 2);
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });
    await stream.ready;

    await emit(store, bus, OTHER_SESSION, "not yours");

    expect(socket.events).toEqual([]);
  });
});

describe("saying the log has been delivered", () => {
  it("announces it even when there is nothing to replay", async () => {
    // The case the whole frame exists for: without it, a project nobody has typed into and one
    // whose conversation is still arriving look identical to a client, and it has to guess
    // which of two opposite things to draw.
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });
    await stream.ready;

    expect(socket.frameTypes()).toEqual(["ready"]);
  });

  it("announces it after the events that arrived mid-connect, not before them", async () => {
    // The buffered remainder is part of "everything up to now". Announcing before the flush
    // would tell a client the log was complete while two of its events were still in a queue.
    const inner = new InMemoryEventStore();
    const store = new SlowStore(inner);
    const bus = new InMemoryEventBus();
    await seed(inner, SESSION, 1);
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });
    await emit(inner, bus, SESSION, "mid-connect");
    store.release();
    await stream.ready;

    expect(socket.frameTypes()).toEqual(["event", "event", "ready"]);
  });

  it("says it once, however long the connection lives", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });
    await stream.ready;

    await emit(store, bus, SESSION, "live");
    await emit(store, bus, SESSION, "live again");

    expect(socket.frameTypes().filter((type) => type === "ready")).toHaveLength(1);
  });
});

describe("connecting during an active turn", () => {
  it("delivers the in-flight remainder exactly once", async () => {
    // Events published between "read the history" and "start listening" are lost unless the
    // subscription is opened first and what arrives is buffered until the replay is out.
    // This is the test that fails if those two are the other way round.
    const inner = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    await seed(inner, SESSION, 10);
    const store = new SlowStore(inner);
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 5, socket });

    // The turn keeps going while the client's history query is still in flight.
    await emit(store, bus, SESSION, "mid-turn a");
    await emit(store, bus, SESSION, "mid-turn b");

    store.release();
    await stream.ready;

    expect(socket.seqs).toEqual([6, 7, 8, 9, 10, 11, 12]);

    await emit(store, bus, SESSION, "after");
    expect(socket.seqs).toEqual([6, 7, 8, 9, 10, 11, 12, 13]);
  });

  it("does not resend an event that the replay already covered", async () => {
    const inner = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    await seed(inner, SESSION, 2);
    const store = new SlowStore(inner);
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });

    // Republished — a duplicate on the bus must not become a duplicate in the transcript.
    const [first] = await inner.readFrom(SESSION, 0);
    bus.publish(first!);

    store.release();
    await stream.ready;

    expect(socket.seqs).toEqual([1, 2]);
  });
});

describe("scene events over replay and resume", () => {
  it("replays scene revisions in order with no duplicates when the live tail overlaps", async () => {
    // The same seam as the chat test above, with the events the viewport folds: a scene
    // revision arriving while the history query is in flight must land exactly once, or the
    // viewport materializes the same revision twice.
    const inner = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    await inner.append(message(SESSION, "make the base wider"));
    await inner.append(sceneUpdated(SESSION, towerSpec(), null));
    const store = new SlowStore(inner);
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });

    // The turn keeps proposing while the client's history query is still in flight.
    await emitEvent(store, bus, sceneRejected(SESSION, "proposal targets an older revision"));
    await emitEvent(store, bus, sceneUpdated(SESSION, widenedTower(), GENESIS_HASH));

    store.release();
    await stream.ready;

    expect(socket.seqs).toEqual([1, 2, 3, 4]);
    expect(socket.events.map((event) => event.type)).toEqual([
      "agent.message",
      "scene.updated",
      "scene.rejected",
      "scene.updated",
    ]);
    const [genesis, wide] = socket.events.flatMap((event) =>
      event.type === "scene.updated" ? [event.payload] : [],
    );
    expect(genesis?.specHash).toBe(GENESIS_HASH);
    expect(wide?.specHash).toBe(WIDE_HASH);
    expect(wide?.parentHash).toBe(GENESIS_HASH);
  });

  it("a reconnect at an intermediate seq receives only the later scene events", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();
    await store.append(message(SESSION, "model me a tower"));
    await store.append(sceneUpdated(SESSION, towerSpec(), null));
    await store.append(sceneUpdated(SESSION, widenedTower(), GENESIS_HASH));

    // The client last heard the chat message — the two scene revisions are what it missed.
    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 1, socket });
    await stream.ready;

    expect(socket.seqs).toEqual([2, 3]);
    expect(socket.events.map((event) => event.type)).toEqual([
      "scene.updated",
      "scene.updated",
    ]);
  });
});

describe("heartbeat", () => {
  it("pings on the interval", async () => {
    vi.useFakeTimers();
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();

    const stream = openEventStream({
      store,
      bus,
      sessionId: SESSION,
      afterSeq: 0,
      socket,
      heartbeat: HEARTBEAT,
    });
    await stream.ready;
    socket.clear();

    vi.advanceTimersByTime(HEARTBEAT.intervalMs * 2);

    expect(socket.frameTypes()).toEqual(["ping", "ping"]);
    expect(socket.closed).toBeUndefined();
  });

  it("closes a connection that has gone silent past the timeout", async () => {
    vi.useFakeTimers();
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();

    const stream = openEventStream({
      store,
      bus,
      sessionId: SESSION,
      afterSeq: 0,
      socket,
      heartbeat: HEARTBEAT,
    });
    await stream.ready;

    vi.advanceTimersByTime(HEARTBEAT.timeoutMs + HEARTBEAT.intervalMs);

    expect(socket.closed?.code).toBe(WS_CLOSE.heartbeatTimeout);
  });

  it("stays open for a client that answers", async () => {
    vi.useFakeTimers();
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();

    const stream = openEventStream({
      store,
      bus,
      sessionId: SESSION,
      afterSeq: 0,
      socket,
      heartbeat: HEARTBEAT,
    });
    await stream.ready;

    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(HEARTBEAT.intervalMs);
      stream.onMessage('{"type":"pong"}');
    }

    expect(socket.closed).toBeUndefined();
  });

  it("stops pinging once the socket is closed", async () => {
    vi.useFakeTimers();
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();

    const stream = openEventStream({
      store,
      bus,
      sessionId: SESSION,
      afterSeq: 0,
      socket,
      heartbeat: HEARTBEAT,
    });
    await stream.ready;
    socket.clear();
    stream.onClose();

    // A timer surviving its connection is one leak per reconnect, and `send` on a closed
    // socket throws in the fake for exactly this reason.
    expect(() => vi.advanceTimersByTime(HEARTBEAT.intervalMs * 5)).not.toThrow();
    expect(socket.sent).toEqual([]);
  });
});

describe("frames from the client", () => {
  it("answers a malformed frame with an error and keeps streaming", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });
    await stream.ready;
    socket.clear();

    stream.onMessage("not json");
    stream.onMessage('{"type":"subscribe","sessionId":"x"}');
    stream.onMessage(new ArrayBuffer(2));

    expect(socket.frameTypes()).toEqual(["error", "error", "error"]);
    expect(socket.closed).toBeUndefined();

    // Still a working connection: a client bug must not cost someone their transcript.
    await emit(store, bus, SESSION, "still here");
    expect(socket.seqs).toEqual([1]);
  });

  it("says nothing back to a valid frame", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });
    await stream.ready;
    socket.clear();

    stream.onMessage('{"type":"pong"}');

    expect(socket.sent).toEqual([]);
  });
});

describe("close", () => {
  it("unsubscribes, so a later event reaches nothing", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });
    await stream.ready;
    socket.clear();
    stream.onClose();

    // One leaked subscriber per reconnect, and the fake throws on send-after-close, so a
    // missing unsubscribe fails loudly here rather than growing quietly in production.
    await emit(store, bus, SESSION, "after close");

    expect(socket.sent).toEqual([]);
  });

  it("releases the subscription rather than only ignoring what arrives", async () => {
    const store = new InMemoryEventStore();
    const bus = new CountingBus();
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });
    await stream.ready;
    expect(bus.subscriptions).toBe(1);

    stream.onClose();

    // The connection is gone; a subscriber that outlives it is a leak per reconnect, and one
    // that merely drops what it receives is indistinguishable from the socket's side.
    expect(bus.subscriptions).toBe(0);
  });

  it("stops the heartbeat as well, so nothing survives the connection", async () => {
    vi.useFakeTimers();
    const store = new InMemoryEventStore();
    const bus = new CountingBus();
    const socket = new FakeSocket();

    const stream = openEventStream({
      store,
      bus,
      sessionId: SESSION,
      afterSeq: 0,
      socket,
      heartbeat: HEARTBEAT,
    });
    await stream.ready;
    expect(vi.getTimerCount()).toBe(1);
    socket.clear();

    stream.onClose();

    // The interval is gone, not merely inert: a timer that only checks a flag still fires
    // for every dead connection, and keeps the process from settling.
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(HEARTBEAT.timeoutMs * 3);
    expect(socket.sent).toEqual([]);
    expect(bus.subscriptions).toBe(0);
  });

  it("is safe to call twice", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });
    await stream.ready;

    stream.onClose();
    expect(() => stream.onClose()).not.toThrow();
  });

  it("sends nothing that was replaying when the socket went away", async () => {
    const inner = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    await seed(inner, SESSION, 3);
    const store = new SlowStore(inner);
    const socket = new FakeSocket();

    const stream = openEventStream({ store, bus, sessionId: SESSION, afterSeq: 0, socket });
    stream.onClose();
    store.release();
    await stream.ready;

    expect(socket.sent).toEqual([]);
  });
});

describe("turn stream events", () => {
  it("broadcasts all TurnStreamEvent variants to connected socket", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const turnBus = new TurnStreamBus();
    const socket = new FakeSocket();

    const stream = openEventStream({
      store,
      bus,
      sessionId: SESSION,
      afterSeq: 0,
      socket,
      turnBus,
    });
    await stream.ready;
    socket.clear();

    const events: TurnStreamEvent[] = [
      {
        type: "turn.state_changed",
        turnId: TURN,
        from: "queued",
        to: "planning_scene",
        timestamp: "2026-08-09T12:00:00.000Z",
      },
      {
        type: "turn.needs_input",
        turnId: TURN,
        ambiguityReason: "Dimensions missing",
        questions: ["What size?"],
      },
      {
        type: "turn.plan_ready",
        turnId: TURN,
        sceneSummary: "office desk",
        totalSteps: 2,
        steps: [
          { stepId: "s1", goal: "frame" },
          { stepId: "s2", goal: "top" },
        ],
      },
      {
        type: "turn.step_started",
        turnId: TURN,
        stepIndex: 0,
        stepId: "s1",
        attempt: 1,
        model: "qwen/qwen-2.5-coder-32b-instruct",
      },
      {
        type: "turn.gate_result",
        turnId: TURN,
        stepId: "s1",
        attempt: 1,
        gate: 1,
        passed: true,
      },
      {
        type: "turn.step_committed",
        turnId: TURN,
        stepIndex: 0,
        stepId: "s1",
        newRevision: 1,
        sceneDelta: { added: ["desk_frame"] },
      },
      {
        type: "turn.stale_rebase",
        turnId: TURN,
        expectedRevision: 1,
        actualRevision: 2,
        rebaseAttempt: 1,
      },
      {
        type: "turn.completed",
        turnId: TURN,
        finalRevision: 2,
      },
      {
        type: "turn.failed",
        turnId: TURN,
        stepId: "s1",
        reason: "Retry budget exhausted",
      },
    ];

    for (const event of events) {
      turnBus.broadcast(SESSION, event);
    }

    expect(socket.sent).toHaveLength(9);
    for (let i = 0; i < events.length; i++) {
      expect(JSON.parse(socket.sent[i]!)).toEqual(events[i]);
    }
  });

  it("isolates turn stream events by session", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const turnBus = new TurnStreamBus();
    const socket = new FakeSocket();

    const stream = openEventStream({
      store,
      bus,
      sessionId: SESSION,
      afterSeq: 0,
      socket,
      turnBus,
    });
    await stream.ready;
    socket.clear();

    turnBus.broadcast(OTHER_SESSION, {
      type: "turn.completed",
      turnId: "other-turn",
      finalRevision: 1,
    });

    expect(socket.sent).toHaveLength(0);
  });

  it("sendTurnEvent delivers directly on the stream instance", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const socket = new FakeSocket();

    const stream = openEventStream({
      store,
      bus,
      sessionId: SESSION,
      afterSeq: 0,
      socket,
    });
    await stream.ready;
    socket.clear();

    const event: TurnStreamEvent = {
      type: "turn.completed",
      turnId: TURN,
      finalRevision: 3,
    };
    stream.sendTurnEvent(event);

    expect(socket.sent).toHaveLength(1);
    expect(JSON.parse(socket.sent[0]!)).toEqual(event);
  });

  it("unsubscribes from turnBus on close", async () => {
    const store = new InMemoryEventStore();
    const bus = new InMemoryEventBus();
    const turnBus = new TurnStreamBus();
    const socket = new FakeSocket();

    const stream = openEventStream({
      store,
      bus,
      sessionId: SESSION,
      afterSeq: 0,
      socket,
      turnBus,
    });
    await stream.ready;
    expect(turnBus.subscriberCount).toBe(1);

    stream.onClose();
    expect(turnBus.subscriberCount).toBe(0);
  });
});

