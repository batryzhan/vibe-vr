/**
 * Environment validation, run once at boot.
 *
 * A misconfigured process should die immediately with a message naming everything that is
 * wrong — not start successfully and fail hours later on the first request that happens to
 * need a variable. Zod collects every issue in one pass, which is what makes the "list all
 * missing keys" behaviour fall out naturally rather than needing to be assembled by hand.
 *
 * `parseEnv` takes a record instead of reading `process.env` itself, so it is testable
 * without mutating global state, and so boot order never depends on import order. Only
 * `index.ts` hands it the real environment.
 *
 * Only keys the API reads *today* are required. Credentials for services no code touches yet
 * become required in the task that first reads them — a fail-fast check that fails on things
 * you do not actually need trains people to fill it with dummy values.
 */

import { z } from "zod";

const BaseSchema = z.object({
  DATABASE_URL: z.string().min(1),
  /**
   * Which provider serves model requests. Dahl is the default for the current agent workflow;
   * the other entries remain available for deployments that explicitly select them.
   * Credentials are checked conditionally below so unrelated provider keys are never required.
   */
  VIBE_VR_PLATFORM: z.enum(["alem", "dahl", "openrouter", "anthropic", "bedrock"]).default("alem"),
  ALEM_API_KEY: z.string().min(1).optional(),
  ALEM_BASE_URL: z.url().default("https://llm.alem.ai/v1"),
  ALEM_MODEL: z.string().min(1).default("qwen3-8"),
  DAHL_API_KEY: z.string().min(1).optional(),
  DAHL_BASE_URL: z.url().default("https://inference.dahl.global/v1"),
  DAHL_PRIMARY_MODEL: z.string().min(1).default("zai-org/GLM-5.3-Flash"),
  DAHL_SPATIAL_MODEL: z.string().min(1).default("deepseek-ai/DeepSeek-V4-Flash-0731"),
  DAHL_COMPOSITION_MODEL: z.string().min(1).default("MiniMaxAI/MiniMax-M2.7"),
  DAHL_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().max(180_000).default(120_000),
  DAHL_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  DAHL_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  DAHL_MAX_PARALLEL_AGENTS: z.coerce.number().int().min(1).max(2).default(2),
  DAHL_MAX_ORCHESTRATION_ROUNDS: z.coerce.number().int().min(0).max(1).default(1),
  DAHL_MAX_COMPLETION_TOKENS: z.coerce.number().int().positive().max(32_000).default(8_000),
  /** Optional credentials for deployments using OpenRouter instead of the default Dahl route. */
  OPENROUTER_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  /** Bedrock takes an API key as a bearer token, and throws at construction with no region. */
  AWS_BEARER_TOKEN_BEDROCK: z.string().min(1).optional(),
  AWS_REGION: z.string().min(1).optional(),
  /**
   * Signs session cookies. Required from the moment there is sign-in to sign: a process that
   * cannot verify its own cookies has no way to tell who is asking.
   */
  BETTER_AUTH_SECRET: z.string().min(1),
  /**
   * Where the browser app is served from, and the one origin allowed through CORS with
   * credentials. It is a different port from this API in development, so it has to be named —
   * and it cannot be `*`, because a browser will not send a cookie to a wildcard origin.
   */
  VIBE_VR_WEB_ORIGIN: z.url().default("http://localhost:3000"),
  /** Where this API is reached. OAuth redirect URIs are built from it, so it must be right. */
  VIBE_VR_API_URL: z.url().default("http://localhost:3001"),
  /**
   * A GitHub OAuth app, if there is one. Optional but paired — see the check below. Without
   * them the GitHub button simply is not offered and email sign-in works as usual.
   */
  GITHUB_CLIENT_ID: z.string().min(1).optional(),
  GITHUB_CLIENT_SECRET: z.string().min(1).optional(),
  /** A Google OAuth client, if there is one. Optional but paired, exactly like GitHub's. */
  GOOGLE_CLIENT_ID: z.string().min(1).optional(),
  GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
  /**
   * Whether somebody with no account at all may look around.
   *
   * On by default, because a builder nobody can try is a screenshot. Demo visitors get a
   * throwaway identity and their own projects. Server-funded model calls are bounded by the
   * lower rate and sandbox ceilings below. Turning this off makes the deployment private.
   */
  VIBE_VR_ALLOW_DEMO: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /**
   * Seals the API keys people bring with them. 32 bytes, base64.
   *
   * Required, because the account routes exist unconditionally and a process that can store a
   * key it cannot encrypt is worse than one that stores none. Losing or changing it does not
   * corrupt anything — every stored key simply stops opening, and everyone falls back to the
   * free tier until they paste theirs again. That is the intended behaviour of a rotation.
   *
   * `openssl rand -base64 32`.
   */
  VIBE_VR_KEY_ENCRYPTION_SECRET: z
    .string()
    .min(1)
    .refine((value) => Buffer.from(value, "base64").length === 32, {
      message: "must be 32 bytes of base64 — try `openssl rand -base64 32`",
    }),
  /**
   * How a turn's events reach the sockets watching them.
   *
   * `in-process` is an emitter keyed by session id: correct for exactly one replica, and
   * silently wrong for two — a socket on one process never sees a turn run by another and the
   * chat simply stops moving. `postgres` announces `{sessionId, seq}` through `pg_notify` and
   * every process reads the events from the durable log, which works whatever the replica count
   * is.
   *
   * **Defaults to `in-process`, deliberately**, so the single-container deployment that exists
   * keeps working exactly as it did. Scaling a deployment past one replica means setting this
   * *and* raising the replica count; doing only the second is the failure `docs/DEPLOY.md` used to
   * forbid outright. The Kubernetes manifests set it. See `docs/adr/0010`.
   */
  VIBE_VR_EVENT_BUS: z.enum(["in-process", "postgres"]).default("in-process"),
  /**
   * Where the connections that need *session* mode go, when they cannot go where everything else
   * does — which is any deployment behind a transaction pooler. There are two: the `LISTEN` socket
   * every API pod holds, and the reaper's advisory lock. `createListenerConnection` and
   * `createLockConnection` in `@vibe-vr/db` each say why that is not optional for them.
   *
   * Absent means `DATABASE_URL`, which is right for a local Postgres and anything unpooled.
   */
  VIBE_VR_LISTEN_DATABASE_URL: z.string().min(1).optional(),

  /** Environments are all strings; the rest of the app should not have to remember that. */
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  /**
   * What a turn is allowed to spend, and on what.
   *
   * Default model id used for turns.
   */
  VIBE_VR_MODEL: z.string().min(1).default("qwen3-8"),
  /**
   * Effort level passed to providers that support it. Dahl models use their configured
   * orchestration settings; this field remains for the other provider integrations.
   */
  VIBE_VR_EFFORT: z.enum(["low", "medium", "high", "xhigh", "max"]).default("medium"),

  /**
   * Which models a request may ask for, as a comma-separated list.
   *
   * This exists because the turn endpoint accepts a model, and a model id taken from a request
   * body and passed to the provider is a stranger choosing what you pay per token. The
   * allowlist is the whole defence: anything not named here is refused before a sandbox is
   * touched or a single token is spent.
   *
   * The default lists the Alem model used by the local development provider.
   */
  VIBE_VR_ALLOWED_MODELS: z
    .string()
    .default("qwen3-8")
    .transform((list) =>
      list
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ""),
    )
    .refine((models) => models.length > 0, { message: "must name at least one model" }),
  /** Model calls in one turn, and the ceiling on the context assembled for each of them. */
  VIBE_VR_MAX_STEPS: z.coerce.number().int().positive().default(24),
  VIBE_VR_CONTEXT_BUDGET_TOKENS: z.coerce.number().int().positive().default(80_000),

  /**
   * What one person may spend.
   *
   * Every turn is a real model call and a real sandbox billed by the second, so an endpoint with
   * no ceiling is a bill with no ceiling — reachable by a loop in a browser tab as easily as by
   * anyone malicious. The defaults are deliberately tight: a working session is usually five to
   * ten messages, so fifteen an hour is room to work rather than a wall, and two running
   * projects is more than anybody uses at once.
   *
   * `VIBE_VR_MAX_SANDBOXES_TOTAL` is the **cluster-wide** ceiling — it is counted in Postgres and
   * reserved under a lock there, so it means the same number however many processes are running —
   * and it is the only one of the three that bounds what *everybody together* can spend. Per-user
   * limits alone multiply by the number of users, which is the arithmetic that matters the first
   * time this is shown to strangers.
   */
  VIBE_VR_TURNS_PER_HOUR: z.coerce.number().int().positive().default(15),
  VIBE_VR_MAX_SANDBOXES_PER_USER: z.coerce.number().int().positive().default(2),
  VIBE_VR_MAX_SANDBOXES_TOTAL: z.coerce.number().int().positive().default(10),

  /**
   * What somebody spending *this deployment's* money may have.
   *
   * The three above apply to a person paying for their own turns. These apply to everyone else
   * — demo visitors and signed-in people without their own key — and bound server-funded model
   * calls as well as sandbox use.
   */
  VIBE_VR_FREE_TURNS_PER_HOUR: z.coerce.number().int().positive().default(5),
  VIBE_VR_FREE_MAX_SANDBOXES_PER_USER: z.coerce.number().int().positive().default(1),
  /**
   * What a turn runs on when the caller has no key of their own.
   *
   * Defaults to the same model keyed users get, so the demo experience matches the real one.
   * The deployment pays for these turns, bounded by the free-tier rate and sandbox ceilings
   * above.
   */
  VIBE_VR_FREE_MODEL: z.string().min(1).default("qwen3-8"),

  /**
   * Where a project's bytes live while no sandbox is holding them.
   *
   * `r2` is the only production answer: a process without a bucket destroys
   * sandboxes it cannot snapshot, which is the one failure mode this whole area
   * exists to prevent. `local` keeps the same bytes in a directory on this
   * machine instead — for trying the app on a laptop without opening a
   * Cloudflare account. Anything else fails closed at the enum above.
   */
  VIBE_VR_OBJECT_STORE: z.enum(["r2", "local"]).default("r2"),
  VIBE_VR_OBJECT_STORE_DIR: z.string().min(1).default(".nap-objects"),
  R2_ACCOUNT_ID: z.string().min(1).optional(),
  R2_BUCKET: z.string().min(1).optional(),
  R2_ACCESS_KEY_ID: z.string().min(1).optional(),
  R2_SECRET_ACCESS_KEY: z.string().min(1).optional(),

  /**
   * When an unused project is put away, and how long its sandbox lives in the meantime.
   *
   * **The idle threshold must stay well below the sandbox lifetime.** Whichever expires first
   * decides what happens to an idle project: the reaper snapshots it before destroying it, and
   * the provider's own timer simply deletes it. There is a boot check below for that.
   */
  VIBE_VR_REAP_IDLE_MINUTES: z.coerce.number().int().positive().default(10),
  VIBE_VR_REAP_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  VIBE_VR_SANDBOX_TTL_MINUTES: z.coerce.number().int().positive().default(30),

  /**
   * How often to look for turns whose worker died holding their lease.
   *
   * On a schedule of its own rather than the reaper's, because the two answer to different
   * clocks: a project can wait a minute to be put away, and a chat pane waiting on a turn that
   * will never finish cannot. A worker's death is visible within the lease, its grace window and
   * one of these — so this is the only part of that sum a deployment can shorten. It never moves
   * the grace itself, which is a fence rather than a delay; see `@vibe-vr/shared/lease-windows`.
   */
  VIBE_VR_JANITOR_INTERVAL_SECONDS: z.coerce.number().int().positive().default(15),

  /**
   * How many queued turns this process runs at once.
   *
   * A property of the *worker*, not a ceiling on the deployment: what a person may spend is the
   * rate limiters' business and how many sandboxes may exist at once is
   * `VIBE_VR_MAX_SANDBOXES_TOTAL`'s. This is how much of the queue one process takes responsibility
   * for at a time, and the number to turn down when a pod is the bottleneck rather than the bill.
   * A turn that cannot be claimed waits in `turn_requests` rather than being refused, so this
   * changes latency and never who gets in.
   *
   * The default is measured rather than guessed: `docs/scaling-baseline.md` derives 25 per worker
   * across four workers from the ramp's own arrival rate and mean turn, and deliberately sits
   * *below* what that run licenses — its turns cost no CPU and no vendor quota, so a real worker
   * is bounded by local Docker sandboxes and model rate limits long before it is bounded by anything that
   * run measured. Raising it wants a real-vendor run behind it.
   */
  VIBE_VR_WORKER_CONCURRENCY: z.coerce.number().int().positive().default(25),

  /**
   * How long a draining worker waits for the turns it is already running before aborting them.
   *
   * The platform's grace period is the real deadline — 600s inside a 900s grace, per
   * `docs/scaling-design.md` §15. A drain that outlasts it is not a graceful shutdown but a kill,
   * which leaves every lease to expire and every job open for somebody to continue by hand.
   */
  VIBE_VR_DRAIN_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),

  /**
   * Where a worker's claim loop leaves its mark, for a liveness probe to `stat`.
   *
   * Optional, and absent means no heartbeat is written — which is right for `bun run dev:worker`
   * and for a single-container deployment, where nothing is asking. It is set on the worker pods
   * alone: the other two roles never claim anything, so the file would never be written and a
   * probe reading it would restart a healthy process every two minutes.
   *
   * See `worker-heartbeat.ts` for why a worker needs one at all — it serves nothing, so "is this
   * pod alive?" cannot be an HTTP request.
   */
  VIBE_VR_WORKER_HEARTBEAT_FILE: z.string().min(1).optional(),

  /**
   * How many thumbnails one worker photographs at once.
   *
   * Not the worker's concurrency, and that is the whole point: every committed turn is
   * photographed, so at 25 turns in flight this would otherwise be 25 simultaneous Chromium page
   * loads in one container. A thumbnail is best-effort and nobody waits on it, so queueing costs
   * a card that appears a few seconds later while the alternative is an OOMKill that costs every
   * turn in flight. One until measurement says more is safe — `docs/scaling-design.md` §17 (B-6).
   */
  VIBE_VR_CAPTURE_CONCURRENCY: z.coerce.number().int().positive().default(1),

  /**
   * A Chrome or Chromium binary to photograph finished turns with, for the dashboard's cards.
   *
   * Optional, and the one env key here that is genuinely allowed to be absent: without it the
   * API runs exactly as before and the dashboard draws a colour where a screenshot would be.
   * Nothing goes looking for a browser — a capture that silently found *some* binary is worse
   * than one that says it has none.
   */
  VIBE_VR_CHROME_PATH: z.string().min(1).optional(),

  // ── Multi-model pipeline configuration ──────────────────────────────────────
  //
  // Legacy staged scene-evaluation pipeline settings. The default Dahl agent workflow uses
  // the DAHL_* settings above; these values still configure the separate staged pipeline.

  /** Base URL for the OpenRouter provider integration. */
  OPENROUTER_BASE_URL: z.url().default("https://openrouter.ai/api/v1"),

  /**
   * GPT Luna handles two roles: multimodal intake (parsing user images/prompts into
   * structured intent) and Gate 3 vision validation (inspecting rendered screenshots).
   * It is the only model in the pipeline that processes images.
   */
  ORCHESTRATOR_VISION_MODEL: z.string().min(1).default("openai/gpt-5.6-luna"),

  /**
   * DeepSeek-R1 as the "Thinker": evaluates request sufficiency, detects ambiguity,
   * and decomposes construction into ordered atomic steps. Its `<think>` reasoning
   * blocks are stripped before JSON parsing.
   */
  SCENE_PLANNER_MODEL: z.string().min(1).default("deepseek/deepseek-r1"),

  /**
   * Qwen 2.5 Coder as the "Builder": generates procedural JSON for each atomic step.
   * Chosen for its strong structured-output compliance and code generation accuracy.
   * Runs with `responseFormat: { type: "json_object" }` and low temperature.
   */
  GEOMETRY_BUILDER_MODEL: z.string().min(1).default("qwen/qwen-2.5-coder-32b-instruct"),

  /**
   * Fallback builder model, used on the final retry if the primary builder (Qwen)
   * fails Gate 1 or Gate 2. Defaults to GPT Luna, which is more expensive but more
   * reliably produces valid JSON.
   */
  FALLBACK_BUILDER_MODEL: z.string().min(1).default("openai/gpt-5.6-luna"),

  /**
   * How many times a single atomic step may be retried across all three gates before
   * the turn transitions to `failed`. A budget of 3 means 4 total attempts (1 initial
   * + 3 retries). Higher values increase latency and cost; lower values risk failing
   * on steps that would have succeeded with one more try.
   */
  TURN_MAX_RETRY_BUDGET: z.coerce.number().int().positive().default(3),

  /**
   * How many times a turn may rebase (transition `stale` → `planning_scene`) when a
   * concurrent edit changes the base revision. A budget of 2 means 3 total planning
   * attempts. Each rebase re-reads the latest committed scene and replans from scratch,
   * so this bounds the worst-case cost of contention.
   */
  TURN_MAX_REBASE_ATTEMPTS: z.coerce.number().int().nonnegative().default(2),
});

/**
 * The credentials the chosen platform needs, and only those.
 *
 * A `superRefine` rather than two schemas, so one parse still reports every problem at once —
 * which is the whole reason this file validates the way it does.
 */
export const EnvSchema = BaseSchema.superRefine((env, ctx) => {
  const required =
    env.VIBE_VR_PLATFORM === "alem"
      ? (["ALEM_API_KEY"] as const)
      : env.VIBE_VR_PLATFORM === "bedrock"
        ? (["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"] as const)
        : env.VIBE_VR_PLATFORM === "anthropic"
          ? (["ANTHROPIC_API_KEY"] as const)
          : ([] as const);

  for (const key of required) {
    if (env[key] !== undefined) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: `is required when VIBE_VR_PLATFORM is ${env.VIBE_VR_PLATFORM}`,
    });
  }

  // The bucket credentials are required exactly when the bucket is the store.
  // `local` needs none of them, which is the whole point of the escape hatch:
  // demanding credentials nothing reads teaches people to paste dummy values,
  // which is worse than no check.
  if (env.VIBE_VR_OBJECT_STORE === "r2") {
    for (const key of [
      "R2_ACCOUNT_ID",
      "R2_BUCKET",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
    ] as const) {
      if (env[key] !== undefined) continue;
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: "is required when VIBE_VR_OBJECT_STORE is r2 (the default)",
      });
    }
  }

  // Half an OAuth app is not a smaller OAuth app. Configured with only one of the two, the
  // provider would either be silently skipped — a button that vanished for no stated reason —
  // or registered with a blank secret, which fails at the redirect back from the provider,
  // several steps away from the thing that is actually wrong.
  //
  // Written as a loop over the providers rather than once per provider: a copy of this block
  // per vendor is a block somebody adds a third vendor without.
  const oauthPairs = [
    [
      ["GITHUB_CLIENT_ID", env.GITHUB_CLIENT_ID],
      ["GITHUB_CLIENT_SECRET", env.GITHUB_CLIENT_SECRET],
    ],
    [
      ["GOOGLE_CLIENT_ID", env.GOOGLE_CLIENT_ID],
      ["GOOGLE_CLIENT_SECRET", env.GOOGLE_CLIENT_SECRET],
    ],
  ] as const;

  for (const pair of oauthPairs) {
    if (pair.filter(([, value]) => value !== undefined).length !== 1) continue;

    for (const [key, value] of pair) {
      if (value !== undefined) continue;
      const sibling = pair.find(([name]) => name !== key)?.[0];
      ctx.addIssue({
        code: "custom",
        path: [key],
        message: `is required when ${sibling} is set`,
      });
    }
  }

  // The default has to be reachable, or every turn that names no model is refused by the
  // allowlist that was meant to protect it — a server that boots fine and answers nothing.
  if (!env.VIBE_VR_ALLOWED_MODELS.includes(env.VIBE_VR_MODEL)) {
    ctx.addIssue({
      code: "custom",
      path: ["VIBE_VR_ALLOWED_MODELS"],
      message: `must include VIBE_VR_MODEL (${env.VIBE_VR_MODEL})`,
    });
  }

  // The free-tier model has to be reachable too, or every turn by somebody without a key is
  // refused by the allowlist — which is everybody on their first visit.
  if (!env.VIBE_VR_ALLOWED_MODELS.includes(env.VIBE_VR_FREE_MODEL)) {
    ctx.addIssue({
      code: "custom",
      path: ["VIBE_VR_ALLOWED_MODELS"],
      message: `must include VIBE_VR_FREE_MODEL (${env.VIBE_VR_FREE_MODEL})`,
    });
  }

  // No `:free` suffix requirement: the deployment intentionally pays for demo turns on Luna,
  // bounded by the free-tier rate and sandbox ceilings. The cost is real but small and
  // deliberate — a demo that runs on the same model the product actually uses is worth more
  // than the tokens it saves by running on a weaker one.

  // A per-user cap above the machine-wide one is unreachable: the global check would refuse
  // first, and the message would talk about the server being busy when the projects filling it
  // are the asker's own. Loud here rather than confusing at request time.
  for (const key of [
    "VIBE_VR_MAX_SANDBOXES_PER_USER",
    "VIBE_VR_FREE_MAX_SANDBOXES_PER_USER",
  ] as const) {
    if (env[key] <= env.VIBE_VR_MAX_SANDBOXES_TOTAL) continue;
    ctx.addIssue({
      code: "custom",
      path: [key],
      message: `must not exceed VIBE_VR_MAX_SANDBOXES_TOTAL (${env.VIBE_VR_MAX_SANDBOXES_TOTAL}), or the per-user limit can never be reached`,
    });
  }

  // A configuration that reaps later than the provider kills is worse than no reaper at all:
  // every idle project would be deleted without a snapshot, silently, and the logs would show
  // a reaper finding nothing to do.
  if (env.VIBE_VR_REAP_IDLE_MINUTES >= env.VIBE_VR_SANDBOX_TTL_MINUTES) {
    ctx.addIssue({
      code: "custom",
      path: ["VIBE_VR_REAP_IDLE_MINUTES"],
      message: `must be less than VIBE_VR_SANDBOX_TTL_MINUTES (${env.VIBE_VR_SANDBOX_TTL_MINUTES}), or sandboxes expire before they are snapshotted`,
    });
  }
});

export type Env = z.infer<typeof EnvSchema>;

/** Thrown when the environment is unusable. Not a typed result — there is no recovering. */
export class EnvValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(
      `Invalid environment:\n${issues.map((i) => `  - ${i}`).join("\n")}\n\n` +
        "See apps/api/.env.example for the full list.",
    );
    this.name = "EnvValidationError";
  }
}

export function parseEnv(source: Record<string, string | undefined>): Env {
  const normalized = { ...source };
  for (const [key, value] of Object.entries(source)) {
    if (!key.startsWith("NAP_")) continue;
    const renamedKey = `VIBE_VR_${key.slice("NAP_".length)}`;
    if (normalized[renamedKey] === undefined) normalized[renamedKey] = value;
  }

  const result = EnvSchema.safeParse(normalized);
  if (result.success) return result.data;

  // One line per problem, each naming its key, so a single run tells you everything to fix.
  const issues = result.error.issues.map((issue) => {
    const key = issue.path.join(".") || "(root)";
    return `${key}: ${issue.message}`;
  });
  throw new EnvValidationError(issues);
}
