import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.ts";

/**
 * `parseEnv` takes a plain record rather than reading `process.env`, so these tests never
 * mutate global state and never depend on what happens to be exported in the shell.
 */

/** The bucket a project's bytes live in while nothing is running. */
const R2 = {
  R2_ACCOUNT_ID: "0123456789abcdef",
  R2_BUCKET: "nap-snapshots",
  R2_ACCESS_KEY_ID: "r2-key",
  R2_SECRET_ACCESS_KEY: "r2-secret",
} as const;

const VALID = {
  DATABASE_URL: "postgres://nap:nap@localhost:5432/nap",
  // Kept only for the optional legacy OpenRouter platform.
  OPENROUTER_API_KEY: "sk-or-test",
  ALEM_API_KEY: "alem-test-key",
  DAHL_API_KEY: "dahl-test-key",
  BETTER_AUTH_SECRET: "a-secret-long-enough-to-sign-a-cookie-with",
  // 32 bytes of base64, which is what seals the API keys people bring with them.
  VIBE_VR_KEY_ENCRYPTION_SECRET: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  ...R2,
  PORT: "3001",
  LOG_LEVEL: "info",
  NODE_ENV: "development",
} as const;

/** Only the keys with no default. */
const REQUIRED = {
  DATABASE_URL: VALID.DATABASE_URL,
  ALEM_API_KEY: VALID.ALEM_API_KEY,
  BETTER_AUTH_SECRET: VALID.BETTER_AUTH_SECRET,
  VIBE_VR_KEY_ENCRYPTION_SECRET: VALID.VIBE_VR_KEY_ENCRYPTION_SECRET,
  ...R2,
} as const;

describe("parseEnv", () => {
  it("accepts a complete environment", () => {
    const env = parseEnv(VALID);
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(env.NODE_ENV).toBe("development");
  });

  it("requires the authentication secrets", () => {
    // The server now creates sandboxes and calls the model itself. Both keys become required
    // in the task that first reads them, which is this one — a process that boots without
    // them only fails on the first message someone sends.
    const { BETTER_AUTH_SECRET: _omitted, ...rest } = REQUIRED;

    expect(() => parseEnv(rest)).toThrow(/BETTER_AUTH_SECRET/);
  });

  it("requires the Alem key for the default provider", () => {
    const { ALEM_API_KEY: _key, ...missingKey } = REQUIRED;
    expect(() => parseEnv(missingKey)).toThrow(/ALEM_API_KEY/);
  });

  it("wants AWS credentials instead when the models are reached through Bedrock", () => {
    // Not a second vendor — the same models billed to an AWS account. Demanding an Anthropic
    // key from someone paying through AWS is exactly the kind of check that teaches people to
    // paste dummy values.
    const bedrock = {
      DATABASE_URL: VALID.DATABASE_URL,
      VIBE_VR_PLATFORM: "bedrock",
      AWS_BEARER_TOKEN_BEDROCK: "ABSK-test",
      AWS_REGION: "us-east-1",
      BETTER_AUTH_SECRET: VALID.BETTER_AUTH_SECRET,
      VIBE_VR_KEY_ENCRYPTION_SECRET: VALID.VIBE_VR_KEY_ENCRYPTION_SECRET,
      ...R2,
    };

    expect(parseEnv(bedrock).VIBE_VR_PLATFORM).toBe("bedrock");
  });

  it.each(["AWS_BEARER_TOKEN_BEDROCK", "AWS_REGION"])("requires %s on Bedrock", (key) => {
    // The region especially: the Bedrock client throws at *construction* without one, so a
    // missing region is a stack trace at boot rather than a sentence naming the variable.
    const bedrock: Record<string, string> = {
      DATABASE_URL: VALID.DATABASE_URL,
      VIBE_VR_PLATFORM: "bedrock",
      AWS_BEARER_TOKEN_BEDROCK: "ABSK-test",
      AWS_REGION: "us-east-1",
      BETTER_AUTH_SECRET: VALID.BETTER_AUTH_SECRET,
      VIBE_VR_KEY_ENCRYPTION_SECRET: VALID.VIBE_VR_KEY_ENCRYPTION_SECRET,
      ...R2,
    };
    delete bedrock[key];

    expect(() => parseEnv(bedrock)).toThrow(new RegExp(key));
  });

  it("does not ask for an Anthropic key on the Bedrock path", () => {
    expect(() =>
      parseEnv({
        DATABASE_URL: VALID.DATABASE_URL,
        VIBE_VR_PLATFORM: "bedrock",
        AWS_BEARER_TOKEN_BEDROCK: "ABSK-test",
        AWS_REGION: "us-east-1",
        BETTER_AUTH_SECRET: VALID.BETTER_AUTH_SECRET,
        VIBE_VR_KEY_ENCRYPTION_SECRET: VALID.VIBE_VR_KEY_ENCRYPTION_SECRET,
        ...R2,
      }),
    ).not.toThrow();
  });

  it("uses Alem by default for model calls", () => {
    expect(parseEnv(REQUIRED).VIBE_VR_PLATFORM).toBe("alem");
  });

  it("requires an Alem API key when Alem is selected", () => {
    const { ALEM_API_KEY: _key, ...missingKey } = REQUIRED;
    expect(() => parseEnv(missingKey)).toThrow(/ALEM_API_KEY/);
  });

  it("wants an Anthropic key instead when Anthropic is billed directly", () => {
    // Still a supported route, and the check stays conditional for the same reason it always
    // did: demanding an OpenRouter key from someone paying Anthropic directly is exactly the
    // kind of boot check that teaches people to paste dummy values.
    const anthropic = {
      DATABASE_URL: VALID.DATABASE_URL,
      VIBE_VR_PLATFORM: "anthropic",
      ANTHROPIC_API_KEY: "sk-ant-test",
      BETTER_AUTH_SECRET: VALID.BETTER_AUTH_SECRET,
      VIBE_VR_KEY_ENCRYPTION_SECRET: VALID.VIBE_VR_KEY_ENCRYPTION_SECRET,
      ...R2,
    };

    expect(parseEnv(anthropic).VIBE_VR_PLATFORM).toBe("anthropic");
  });

  it("refuses to boot on the Anthropic path with no Anthropic key", () => {
    expect(() =>
      parseEnv({ ...REQUIRED, VIBE_VR_PLATFORM: "anthropic", OPENROUTER_API_KEY: undefined }),
    ).toThrow(/ANTHROPIC_API_KEY/);
  });

  it("boots with no GitHub app at all, leaving email sign-in as the only way in", () => {
    // The rule this repo states outright: a boot check that demands credentials for something
    // nobody has configured is how people learn to paste dummy values.
    expect(() => parseEnv(REQUIRED)).not.toThrow();
  });

  it.each(["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"])(
    "refuses %s on its own, since half a GitHub app is not a smaller one",
    (key) => {
      // The alternative failure is a redirect back from GitHub that dies on a blank secret —
      // several steps away from the thing that is actually wrong.
      const other = key === "GITHUB_CLIENT_ID" ? "GITHUB_CLIENT_SECRET" : "GITHUB_CLIENT_ID";

      expect(() => parseEnv({ ...REQUIRED, [key]: "set" })).toThrow(new RegExp(other));
    },
  );

  it("accepts both halves of a GitHub app together", () => {
    expect(() =>
      parseEnv({ ...REQUIRED, GITHUB_CLIENT_ID: "Iv1.test", GITHUB_CLIENT_SECRET: "ghs_test" }),
    ).not.toThrow();
  });

  it.each(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"])(
    "refuses %s on its own, the same way GitHub's halves are paired",
    (key) => {
      const other = key === "GOOGLE_CLIENT_ID" ? "GOOGLE_CLIENT_SECRET" : "GOOGLE_CLIENT_ID";

      expect(() => parseEnv({ ...REQUIRED, [key]: "set" })).toThrow(new RegExp(other));
    },
  );

  it("accepts both halves of a Google app together", () => {
    expect(() =>
      parseEnv({
        ...REQUIRED,
        GOOGLE_CLIENT_ID: "123.apps.googleusercontent.com",
        GOOGLE_CLIENT_SECRET: "GOCSPX-test",
      }),
    ).not.toThrow();
  });

  it("leaves the demo door open unless it is closed deliberately", () => {
    // A builder nobody can try is a screenshot. What keeps that affordable is the free tier's
    // own ceilings, not a closed door.
    expect(parseEnv(REQUIRED).VIBE_VR_ALLOW_DEMO).toBe(true);
    expect(parseEnv({ ...REQUIRED, VIBE_VR_ALLOW_DEMO: "false" }).VIBE_VR_ALLOW_DEMO).toBe(false);
  });

  it("requires an encryption secret of exactly 32 bytes", () => {
    // A short secret is the realistic mistake — a hand-typed value rather than
    // `openssl rand -base64 32` — and without this it fails at somebody's first save instead
    // of at boot.
    expect(() => parseEnv({ ...REQUIRED, VIBE_VR_KEY_ENCRYPTION_SECRET: "too-short" })).toThrow(
      /VIBE_VR_KEY_ENCRYPTION_SECRET/,
    );
  });

  it("refuses a free-tier model that is not on the allowlist", () => {
    expect(() => parseEnv({ ...REQUIRED, VIBE_VR_FREE_MODEL: "vendor/absent-model" })).toThrow(
      /VIBE_VR_FREE_MODEL/,
    );
  });

  it("defaults the free tier tighter than the paying one", () => {
    // Not a coincidence to be preserved by luck: these are the ceilings on what a stranger can
    // spend of *this* deployment's money, and they exist to be lower.
    const env = parseEnv(REQUIRED);

    expect(env.VIBE_VR_FREE_TURNS_PER_HOUR).toBeLessThan(env.VIBE_VR_TURNS_PER_HOUR);
    expect(env.VIBE_VR_FREE_MAX_SANDBOXES_PER_USER).toBeLessThanOrEqual(
      env.VIBE_VR_MAX_SANDBOXES_PER_USER,
    );
    // The free model is Luna — the same as the paid default. The deployment intentionally pays
    // for demo turns so the demo experience matches the real product.
    expect(env.VIBE_VR_FREE_MODEL).toBe("qwen3-8");
  });

  it("refuses a free-tier sandbox cap above the machine-wide one", () => {
    expect(() => parseEnv({ ...REQUIRED, VIBE_VR_FREE_MAX_SANDBOXES_PER_USER: "99" })).toThrow(
      /VIBE_VR_FREE_MAX_SANDBOXES_PER_USER/,
    );
  });

  it("defaults the model to Alem Qwen", () => {
    // Every message typed into the box spends money. What it spends by default is a decision,
    // and the default is the same model `harness --real` uses.
    const env = parseEnv(REQUIRED);

    expect(env.VIBE_VR_MODEL).toBe("qwen3-8");
    expect(env.VIBE_VR_EFFORT).toBe("medium");
  });

  it("takes a different model when one is asked for", () => {
    const env = parseEnv({
      ...REQUIRED,
      VIBE_VR_MODEL: "alternate-model",
      VIBE_VR_ALLOWED_MODELS: "qwen3-8,alternate-model",
      VIBE_VR_EFFORT: "xhigh",
    });

    expect(env.VIBE_VR_MODEL).toBe("alternate-model");
    expect(env.VIBE_VR_EFFORT).toBe("xhigh");
  });

  it("rejects an effort level the provider would refuse", () => {
    expect(() => parseEnv({ ...REQUIRED, VIBE_VR_EFFORT: "maximum" })).toThrow(/VIBE_VR_EFFORT/);
  });

  it("coerces the numeric budgets", () => {
    const env = parseEnv({
      ...REQUIRED,
      VIBE_VR_MAX_STEPS: "20",
      VIBE_VR_CONTEXT_BUDGET_TOKENS: "80000",
    });

    expect(env.VIBE_VR_MAX_STEPS).toBe(20);
    expect(env.VIBE_VR_CONTEXT_BUDGET_TOKENS).toBe(80_000);
  });

  it("coerces PORT to a number", () => {
    // Everything in an environment is a string; the rest of the app should not have to
    // remember that.
    expect(parseEnv(VALID).PORT).toBe(3001);
    expect(typeof parseEnv(VALID).PORT).toBe("number");
  });

  it("applies defaults for the optional keys", () => {
    const env = parseEnv(REQUIRED);
    expect(env.PORT).toBe(3001);
    expect(env.LOG_LEVEL).toBe("info");
    expect(env.NODE_ENV).toBe("development");
  });
});

describe("parseEnv failure", () => {
  it("names every missing key, not just the first", () => {
    // The whole point of validating at boot: one run should tell you everything to fix.
    // Reporting only the first key turns setup into a guessing game.
    let message = "";
    try {
      parseEnv({ LOG_LEVEL: "info" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DATABASE_URL");
  });

  it("names every invalid key when several are wrong at once", () => {
    let message = "";
    try {
      parseEnv({ DATABASE_URL: "", PORT: "not-a-number", LOG_LEVEL: "loud", NODE_ENV: "banana" });
    } catch (error) {
      message = (error as Error).message;
    }
    for (const key of ["DATABASE_URL", "PORT", "LOG_LEVEL", "NODE_ENV"] as const) {
      expect(message).toContain(key);
    }
  });

  it("rejects a non-numeric PORT", () => {
    expect(() => parseEnv({ ...VALID, PORT: "http" })).toThrow(/PORT/);
  });

  it("rejects an unknown LOG_LEVEL rather than silently defaulting", () => {
    expect(() => parseEnv({ ...VALID, LOG_LEVEL: "chatty" })).toThrow(/LOG_LEVEL/);
  });

  it("throws rather than returning a result, because a bad env is not a recoverable state", () => {
    expect(() => parseEnv({})).toThrow();
  });
});

describe("putting projects away", () => {
  it("defaults to reaping well before a sandbox expires on its own", () => {
    const env = parseEnv(REQUIRED);

    expect(env.VIBE_VR_REAP_IDLE_MINUTES).toBe(10);
    expect(env.VIBE_VR_SANDBOX_TTL_MINUTES).toBe(30);
    expect(env.VIBE_VR_REAP_INTERVAL_SECONDS).toBe(60);
  });

  it("refuses to boot when a sandbox would expire before it is reaped", () => {
    // The whole point of the reaper is that a project is snapshotted before it is destroyed.
    // Configured this way, the provider's timer wins every race and idle projects are simply
    // deleted — with a reaper in the logs cheerfully finding nothing to do.
    expect(() =>
      parseEnv({ ...REQUIRED, VIBE_VR_REAP_IDLE_MINUTES: "45", VIBE_VR_SANDBOX_TTL_MINUTES: "30" }),
    ).toThrow(/VIBE_VR_REAP_IDLE_MINUTES/);
  });

  it("refuses the equal case too, which has the same race", () => {
    expect(() =>
      parseEnv({ ...REQUIRED, VIBE_VR_REAP_IDLE_MINUTES: "30", VIBE_VR_SANDBOX_TTL_MINUTES: "30" }),
    ).toThrow(/VIBE_VR_REAP_IDLE_MINUTES/);
  });

  it("requires somewhere to put the bytes", () => {
    // A server that can destroy sandboxes but not snapshot them is worse than one that does
    // neither, so the bucket credentials stay required while the bucket is the store.
    const { R2_BUCKET: _omitted, ...rest } = REQUIRED;

    expect(() => parseEnv(rest)).toThrow(/R2_BUCKET/);
  });

  it("boots without bucket credentials on the local store", () => {
    const {
      R2_ACCOUNT_ID: _a,
      R2_BUCKET: _b,
      R2_ACCESS_KEY_ID: _c,
      R2_SECRET_ACCESS_KEY: _d,
      ...rest
    } = REQUIRED;

    const env = parseEnv({ ...rest, VIBE_VR_OBJECT_STORE: "local" });
    expect(env.VIBE_VR_OBJECT_STORE).toBe("local");
  });

  it("refuses an unknown store rather than guessing", () => {
    expect(() => parseEnv({ ...REQUIRED, VIBE_VR_OBJECT_STORE: "s3" })).toThrow(
      /VIBE_VR_OBJECT_STORE/,
    );
  });
});

describe("what one person may spend", () => {
  it("defaults to limits tight enough to bound a runaway", () => {
    // These are the numbers that decide what a stranger can spend on your behalf, so they are
    // asserted rather than left to whatever the schema happens to say.
    const env = parseEnv(REQUIRED);

    expect(env.VIBE_VR_TURNS_PER_HOUR).toBe(15);
    expect(env.VIBE_VR_MAX_SANDBOXES_PER_USER).toBe(2);
    expect(env.VIBE_VR_MAX_SANDBOXES_TOTAL).toBe(10);
  });

  it("refuses a per-user cap above the machine-wide one", () => {
    // Configured that way the per-user limit can never be reached: the global check refuses
    // first, and tells the asker the server is busy when the projects filling it are their own.
    expect(() =>
      parseEnv({
        ...REQUIRED,
        VIBE_VR_MAX_SANDBOXES_PER_USER: "5",
        VIBE_VR_MAX_SANDBOXES_TOTAL: "3",
      }),
    ).toThrow(/VIBE_VR_MAX_SANDBOXES_PER_USER/);
  });

  it("accepts the two being equal, which is a single-user deployment", () => {
    expect(() =>
      parseEnv({
        ...REQUIRED,
        VIBE_VR_MAX_SANDBOXES_PER_USER: "3",
        VIBE_VR_MAX_SANDBOXES_TOTAL: "3",
      }),
    ).not.toThrow();
  });

  it("rejects a zero or negative limit rather than silently blocking every turn", () => {
    // `0` reads like "no limit" and means the opposite: every turn refused, with a message
    // about rate limiting that nobody could act on.
    expect(() => parseEnv({ ...REQUIRED, VIBE_VR_TURNS_PER_HOUR: "0" })).toThrow(
      /VIBE_VR_TURNS_PER_HOUR/,
    );
    expect(() => parseEnv({ ...REQUIRED, VIBE_VR_MAX_SANDBOXES_PER_USER: "-1" })).toThrow(
      /VIBE_VR_MAX_SANDBOXES_PER_USER/,
    );
  });
});

describe("VIBE_VR_ALLOWED_MODELS", () => {
  it("lists only the Alem Qwen model by default", () => {
    expect(parseEnv(VALID).VIBE_VR_ALLOWED_MODELS).toEqual(["qwen3-8"]);
  });

  it("starts the default the model every turn falls back to", () => {
    // The boot check below refuses a default that is not allowed, so this is not about
    // reachability — it is that the first model in the list should be the one a fresh checkout runs on.
    const allowed = parseEnv(VALID).VIBE_VR_ALLOWED_MODELS;

    expect(allowed[0]).toBe(parseEnv(VALID).VIBE_VR_MODEL);
  });

  it("keeps the configured Alem model in the server allowlist", () => {
    expect(parseEnv(VALID).VIBE_VR_ALLOWED_MODELS).toEqual(["qwen3-8"]);
  });

  it("splits a list and forgives the spaces people type after commas", () => {
    const env = parseEnv({
      ...VALID,
      VIBE_VR_MODEL: "a/one",
      VIBE_VR_FREE_MODEL: "c/three:free",
      VIBE_VR_ALLOWED_MODELS: "a/one, b/two ,c/three:free",
    });

    expect(env.VIBE_VR_ALLOWED_MODELS).toEqual(["a/one", "b/two", "c/three:free"]);
  });

  it("refuses to boot when the default is not one of the allowed models", () => {
    // Otherwise every turn that names no model — which is all of them, by default — is refused
    // by the allowlist meant to protect it: a server that starts cleanly and answers nothing.
    expect(() =>
      parseEnv({
        ...VALID,
        VIBE_VR_MODEL: "a/one",
        VIBE_VR_FREE_MODEL: "b/two:free",
        VIBE_VR_ALLOWED_MODELS: "b/two:free",
      }),
    ).toThrow(/VIBE_VR_ALLOWED_MODELS/);
  });

  it("refuses an empty list rather than allowing everything", () => {
    expect(() => parseEnv({ ...VALID, VIBE_VR_ALLOWED_MODELS: " , " })).toThrow(
      /VIBE_VR_ALLOWED_MODELS/,
    );
  });
});

describe("multi-model pipeline configuration", () => {
  it("defaults role-specific models and pipeline parameters", () => {
    const env = parseEnv(REQUIRED);

    expect(env.DAHL_BASE_URL).toBe("https://inference.dahl.global/v1");
    expect(env.DAHL_PRIMARY_MODEL).toBe("zai-org/GLM-5.3-Flash");
    expect(env.DAHL_SPATIAL_MODEL).toBe("deepseek-ai/DeepSeek-V4-Flash-0731");
    expect(env.DAHL_COMPOSITION_MODEL).toBe("MiniMaxAI/MiniMax-M2.7");
    expect(env.DAHL_MAX_ATTEMPTS).toBe(3);
    expect(env.DAHL_MAX_PARALLEL_AGENTS).toBe(2);

    expect(env.OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(env.ORCHESTRATOR_VISION_MODEL).toBe("openai/gpt-5.6-luna");
    expect(env.SCENE_PLANNER_MODEL).toBe("deepseek/deepseek-r1");
    expect(env.GEOMETRY_BUILDER_MODEL).toBe("qwen/qwen-2.5-coder-32b-instruct");
    expect(env.FALLBACK_BUILDER_MODEL).toBe("openai/gpt-5.6-luna");
    expect(env.TURN_MAX_RETRY_BUDGET).toBe(3);
    expect(env.TURN_MAX_REBASE_ATTEMPTS).toBe(2);
  });

  it("allows overriding multi-model pipeline variables", () => {
    const env = parseEnv({
      ...REQUIRED,
      OPENROUTER_BASE_URL: "https://custom-router.example.com/api/v1",
      ORCHESTRATOR_VISION_MODEL: "custom/vision-model",
      SCENE_PLANNER_MODEL: "custom/planner-model",
      GEOMETRY_BUILDER_MODEL: "custom/builder-model",
      FALLBACK_BUILDER_MODEL: "custom/fallback-model",
      TURN_MAX_RETRY_BUDGET: "5",
      TURN_MAX_REBASE_ATTEMPTS: "4",
    });

    expect(env.OPENROUTER_BASE_URL).toBe("https://custom-router.example.com/api/v1");
    expect(env.ORCHESTRATOR_VISION_MODEL).toBe("custom/vision-model");
    expect(env.SCENE_PLANNER_MODEL).toBe("custom/planner-model");
    expect(env.GEOMETRY_BUILDER_MODEL).toBe("custom/builder-model");
    expect(env.FALLBACK_BUILDER_MODEL).toBe("custom/fallback-model");
    expect(env.TURN_MAX_RETRY_BUDGET).toBe(5);
    expect(env.TURN_MAX_REBASE_ATTEMPTS).toBe(4);
  });
});
