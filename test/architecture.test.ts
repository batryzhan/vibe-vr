import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkDependencyDirection,
  checkSourceImports,
  type Manifest,
  type PackageSources,
} from "./architecture.ts";

const repoRoot = join(import.meta.dirname, "..");

/** Every `.ts`/`.tsx` under `dir`, or nothing if the directory does not exist. */
function readTypeScriptFiles(dir: string, prefix: string): { path: string; contents: string }[] {
  if (!existsSync(dir)) return [];
  return (
    readdirSync(dir, { recursive: true, withFileTypes: true })
      // `.tsx` as well as `.ts`: a React component's imports are dependency
      // edges exactly like a module's.
      .filter((f) => f.isFile() && (f.name.endsWith(".ts") || f.name.endsWith(".tsx")))
      .map((f) => {
        const absolute = join(f.parentPath, f.name);
        return {
          path: `${prefix}/${absolute.slice(dir.length + 1)}`,
          contents: readFileSync(absolute, "utf8"),
        };
      })
  );
}

// The walk hits every TypeScript file in the repo, and five tests want it. Reading it once
// keeps this file's cost where it was before the import check existed.
const workspacePackages: PackageSources[] = ["packages", "apps"].flatMap((group) =>
  readdirSync(join(repoRoot, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = join(repoRoot, group, entry.name);
      const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        name: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const at = `${group}/${entry.name}`;
      return {
        manifest: {
          name: parsed.name,
          dependencies: Object.keys(parsed.dependencies ?? {}),
          devDependencies: Object.keys(parsed.devDependencies ?? {}),
        },
        // `scripts/` as well as `src`: a script is where the real credentials and the real
        // composition live, so an undeclared import there resolves by hoisting exactly as
        // one in `src` does.
        files: [
          ...readTypeScriptFiles(join(dir, "src"), `${at}/src`),
          ...readTypeScriptFiles(join(dir, "scripts"), `${at}/scripts`),
        ],
      };
    }),
);

function readWorkspacePackages(): PackageSources[] {
  return workspacePackages;
}

function readWorkspaceManifests(): Manifest[] {
  return workspacePackages.map((pkg) => pkg.manifest);
}

describe("dependency direction", () => {
  // docs/PLAN.md §0 calls this direction "enforced". This test is what makes
  // that true: runtime → {context, agent, sandbox, db, verify} → shared.
  it("holds across the real workspace", () => {
    expect(checkDependencyDirection(readWorkspaceManifests())).toEqual([]);
  });

  it("keeps @vibe-vr/bench's internal runtime dependencies below it", () => {
    // docs/adr/0001 permits @vibe-vr/bench to carry sibling packages as devDependencies, for
    // their published in-memory fakes — and the checker above reads `dependencies` only,
    // so that arrangement passes partly by not being looked at. This asserts the half that
    // matters directly: what a consumer of the pure core pulls in at runtime.
    //
    // @vibe-vr/verify joined @vibe-vr/shared here at docs/adr/0007, and the list is exhaustive on
    // purpose: what the ADR forbids is the pure core reaching *sideways or up*, so a third
    // entry appearing without a decision behind it is the thing worth failing on.
    //
    // Third-party dependencies are not the subject. The pure core validates every task and
    // report it parses, so it depends on zod exactly as @vibe-vr/shared does; what would break
    // the ADR is an unsanctioned *workspace* package.
    const bench = readWorkspaceManifests().find((m) => m.name === "@vibe-vr/bench");
    expect(bench?.dependencies.filter((dep) => dep.startsWith("@vibe-vr/")).toSorted()).toEqual([
      "@vibe-vr/shared",
      "@vibe-vr/verify",
    ]);
  });

  it("covers every workspace package", () => {
    // Guards against the check silently going quiet because a package was
    // renamed or added and the rule table never learned about it.
    const names = readWorkspaceManifests().map((m) => m.name);
    expect(names.toSorted()).toEqual([
      "@vibe-vr/agent",
      "@vibe-vr/api",
      "@vibe-vr/bench",
      "@vibe-vr/capture",
      "@vibe-vr/context",
      "@vibe-vr/db",
      "@vibe-vr/loadgen",
      "@vibe-vr/napbench",
      "@vibe-vr/procedural",
      "@vibe-vr/runtime",
      "@vibe-vr/sandbox",
      "@vibe-vr/scene-spec",
      "@vibe-vr/shared",
      "@vibe-vr/storage",
      "@vibe-vr/verify",
      "@vibe-vr/web",
    ]);
  });
});

describe("dependency direction at the import", () => {
  // The manifest check above reads package.json and nothing else, so it can only see edges
  // somebody remembered to declare. Bun hoists workspace packages, which means an import of
  // a package this one never declared resolves, typechecks and ships. This is the check that
  // reads what the source actually imports.
  it("holds across the real workspace", () => {
    expect(checkSourceImports(readWorkspacePackages())).toEqual([]);
  });

  it("actually reads a non-trivial number of internal imports", () => {
    // Guards against the check going quiet because the walk broke, or because the specifier
    // pattern stopped matching the import syntax the repo is written in.
    const seen = readWorkspacePackages().flatMap((pkg) =>
      pkg.files.flatMap((file) => file.contents.match(/["']@nap\//g) ?? []),
    );
    expect(seen.length).toBeGreaterThan(100);
  });
});

describe("dependency direction at the import — the checker actually catches violations", () => {
  const pkg = (
    name: string,
    declared: string[],
    files: Record<string, string>,
    devDeclared: string[] = [],
  ): PackageSources[] => [
    {
      manifest: { name, dependencies: declared, devDependencies: devDeclared },
      files: Object.entries(files).map(([path, contents]) => ({ path, contents })),
    },
  ];

  it("catches the edge docs/adr/0007 exists to forbid", () => {
    // The demonstration this check was written for: @vibe-vr/verify reaching up into the thing
    // that grades the system it serves.
    const violations = checkSourceImports(
      pkg("@vibe-vr/verify", ["@vibe-vr/shared", "@vibe-vr/bench"], {
        "packages/verify/src/preview.ts": 'import { CATEGORIES } from "@vibe-vr/bench/category";',
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.from).toBe("packages/verify/src/preview.ts");
    expect(violations[0]?.to).toBe("@vibe-vr/bench");
  });

  it("counts a type-only import, which is the form a violation is likeliest to take", () => {
    // `import type` erases at runtime, so nothing in a build or a bundle notices it. It is
    // still a layering edge: the compiler had to read @vibe-vr/bench to check this file.
    const violations = checkSourceImports(
      pkg("@vibe-vr/verify", ["@vibe-vr/shared", "@vibe-vr/bench"], {
        "packages/verify/src/preview.ts":
          'import type { TaskCategory } from "@vibe-vr/bench/category";',
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.to).toBe("@vibe-vr/bench");
  });

  it("resolves the subpath form to its package", () => {
    // Specifiers here are always deep — `@vibe-vr/bench/category`, never `@vibe-vr/bench` — because
    // every package exports `./*`. Matching the bare name would have caught nothing at all.
    const violations = checkSourceImports(
      pkg("@vibe-vr/agent", ["@vibe-vr/shared", "@vibe-vr/db"], {
        "packages/agent/src/x.ts":
          'import { schema } from "@vibe-vr/db/testing/in-memory-event-store";',
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.to).toBe("@vibe-vr/db");
  });

  it("catches an import of a package the manifest never declared", () => {
    // The hoisting hole. Bun puts every workspace package in one root node_modules, so this
    // resolves at dev time and in the deployed image — which is built by one workspace-wide
    // install from the whole repo — while package.json claims no such edge exists.
    const violations = checkSourceImports(
      pkg("@vibe-vr/runtime", ["@vibe-vr/shared"], {
        "packages/runtime/src/turn.ts": 'import { run } from "@vibe-vr/verify/preview";',
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("does not declare");
  });

  it("catches it in a test file too — that is how it shipped last time", () => {
    // A test importing a sibling with no devDependency on it is the same hole: it works only
    // because of hoisting, and it breaks the moment the package is installed on its own.
    const violations = checkSourceImports(
      pkg("@vibe-vr/agent", ["@vibe-vr/shared"], {
        "packages/agent/src/x.test.ts":
          'const { SYSTEM_PROMPT } = await import("@vibe-vr/context/system-prompt");',
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("does not declare");
  });

  it("lets a test reach sideways once the manifest says so", () => {
    // docs/adr/0001: sibling packages appear under devDependencies for their published fakes,
    // which is what makes runners and adapters testable without a network. The direction rule
    // is about what shipped source may reach for; a declared test-only edge is not that.
    const violations = checkSourceImports(
      pkg(
        "@vibe-vr/bench",
        ["@vibe-vr/shared"],
        {
          "packages/bench/src/runner.test.ts":
            'import { InMemorySandboxManager } from "@vibe-vr/sandbox/testing/in-memory-sandbox-manager";',
        },
        ["@vibe-vr/sandbox"],
      ),
    );
    expect(violations).toEqual([]);
  });

  it("holds shipped source to the table even when the manifest declares the edge", () => {
    // A devDependency is not a licence for src to use it: declaring @vibe-vr/sandbox is how the
    // fakes get in, and the two rules would disagree about @vibe-vr/bench's core if this one
    // read the manifest rather than the layer table.
    const violations = checkSourceImports(
      pkg(
        "@vibe-vr/bench",
        ["@vibe-vr/shared"],
        { "packages/bench/src/runner.ts": 'import { x } from "@vibe-vr/sandbox/template";' },
        ["@vibe-vr/sandbox"],
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("may only depend on");
  });

  it("allows a package to import itself", () => {
    const violations = checkSourceImports(
      pkg("@vibe-vr/shared", [], {
        "packages/shared/src/version.test.ts":
          'import pkg from "@vibe-vr/shared" with { type: "json" };',
      }),
    );
    expect(violations).toEqual([]);
  });

  it("ignores third-party specifiers and relative ones", () => {
    const violations = checkSourceImports(
      pkg("@vibe-vr/context", ["@vibe-vr/shared"], {
        "packages/context/src/engine.ts":
          'import { z } from "zod";\nimport { budget } from "./budget.ts";',
      }),
    );
    expect(violations).toEqual([]);
  });

  it("lets apps import anything they declare", () => {
    const violations = checkSourceImports(
      pkg("@vibe-vr/api", ["@vibe-vr/runtime", "@vibe-vr/shared"], {
        "apps/api/src/index.ts":
          'import { SingleAgentRuntime } from "@vibe-vr/runtime/single-agent-runtime";',
      }),
    );
    expect(violations).toEqual([]);
  });

  it("still requires an app to declare what it imports", () => {
    const violations = checkSourceImports(
      pkg("@vibe-vr/api", ["@vibe-vr/shared"], {
        "apps/api/src/index.ts":
          'import { SingleAgentRuntime } from "@vibe-vr/runtime/single-agent-runtime";',
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("does not declare");
  });

  it("reads re-exports, side-effect imports and require as the edges they are", () => {
    const violations = checkSourceImports(
      pkg("@vibe-vr/verify", ["@vibe-vr/shared"], {
        "packages/verify/src/a.ts": 'export { CATEGORIES } from "@vibe-vr/bench/category";',
        "packages/verify/src/b.ts": 'import "@vibe-vr/bench/register";',
        "packages/verify/src/c.ts": 'const bench = require("@vibe-vr/bench/report");',
      }),
    );
    expect(violations.map((v) => v.from).toSorted()).toEqual([
      "packages/verify/src/a.ts",
      "packages/verify/src/b.ts",
      "packages/verify/src/c.ts",
    ]);
  });

  it("holds a script to the manifest, since hoisting is what makes its imports resolve too", () => {
    const violations = checkSourceImports(
      pkg("@vibe-vr/runtime", ["@vibe-vr/shared"], {
        "packages/runtime/scripts/harness.ts":
          'import { OpenRouter } from "@vibe-vr/agent/openrouter";',
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("does not declare");
  });

  it("lets a declared script compose across layers", () => {
    // A script is credentials and composition — the real E2B sandbox, the real provider — and
    // never ships as a module. It answers to the manifest, not to the layer table.
    const violations = checkSourceImports(
      pkg(
        "@vibe-vr/runtime",
        ["@vibe-vr/shared"],
        {
          "packages/runtime/scripts/harness.ts":
            'import { OpenRouter } from "@vibe-vr/agent/openrouter";',
        },
        ["@vibe-vr/agent"],
      ),
    );
    expect(violations).toEqual([]);
  });

  it("refuses shipped source an edge the manifest only carries for tests", () => {
    // The escape hatch the two rules would otherwise leave open together: the manifest rule
    // reads `dependencies` alone, so an edge parked in devDependencies satisfies "declared"
    // while staying invisible to the direction check.
    const violations = checkSourceImports(
      pkg(
        "@vibe-vr/runtime",
        ["@vibe-vr/shared"],
        {
          "packages/runtime/src/turn.ts":
            'import { AgentService } from "@vibe-vr/agent/agent-service";',
        },
        ["@vibe-vr/agent"],
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("only as a devDependency");
  });

  it("refuses the benchmark to a test, declared or not", () => {
    // The one edge the exemption does not cover. docs/adr/0007: a test importing @vibe-vr/bench
    // still has to typecheck, so it still makes every scoring change a production change.
    const violations = checkSourceImports(
      pkg(
        "@vibe-vr/runtime",
        ["@vibe-vr/shared"],
        { "packages/runtime/src/turn.test.ts": 'import { score } from "@vibe-vr/bench/score";' },
        ["@vibe-vr/bench"],
      ),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("docs/adr/0007");
  });

  it("still lets the benchmark app's own tests use it", () => {
    const violations = checkSourceImports(
      pkg("@vibe-vr/napbench", ["@vibe-vr/bench"], {
        "apps/napbench/src/run.test.ts": 'import { score } from "@vibe-vr/bench/score";',
      }),
    );
    expect(violations).toEqual([]);
  });

  it("fails loudly on a package the rule table has never heard of", () => {
    const violations = checkSourceImports(
      pkg("@vibe-vr/mystery", ["@vibe-vr/shared"], {
        "packages/mystery/src/x.ts": 'import { ok } from "@vibe-vr/shared/result";',
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("unknown");
  });

  it("reports every violating file, not just the first", () => {
    const violations = checkSourceImports(
      pkg("@vibe-vr/verify", ["@vibe-vr/shared", "@vibe-vr/bench"], {
        "packages/verify/src/a.ts": 'import { a } from "@vibe-vr/bench/category";',
        "packages/verify/src/b.ts": 'import { b } from "@vibe-vr/runtime/single-agent-runtime";',
      }),
    );
    expect(violations).toHaveLength(2);
  });
});

describe("dependency direction — the checker actually catches violations", () => {
  // A checker that has never been seen to fail is not known to work. These
  // cases are the reason this file is worth having.
  it("rejects shared depending on anything internal", () => {
    const violations = checkDependencyDirection([
      { name: "@vibe-vr/shared", dependencies: ["@vibe-vr/runtime"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.from).toBe("@vibe-vr/shared");
    expect(violations[0]?.to).toBe("@vibe-vr/runtime");
  });

  it("rejects a leaf package depending on a sibling leaf", () => {
    const violations = checkDependencyDirection([
      { name: "@vibe-vr/agent", dependencies: ["@vibe-vr/db"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("may only depend on");
  });

  it("allows runtime to depend on every inner package", () => {
    const violations = checkDependencyDirection([
      {
        name: "@vibe-vr/runtime",
        dependencies: ["@vibe-vr/context", "@vibe-vr/agent", "@vibe-vr/sandbox", "@vibe-vr/db", "@vibe-vr/shared"],
      },
    ]);
    expect(violations).toEqual([]);
  });

  it("rejects Playwright anywhere but the benchmark app", () => {
    // docs/adr/0001: the deployed image is one workspace-wide install, so a browser driver
    // added to any package is a browser driver the production API carries.
    const violations = checkDependencyDirection([
      { name: "@vibe-vr/capture", dependencies: ["playwright-core"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("BrowserSession");
  });

  it("rejects an exclusive external hidden in devDependencies", () => {
    // The image is built by one workspace-wide `bun install` with no --production, so a
    // devDependency ships too. Reading `dependencies` alone would have let the browser
    // driver into production through the back door — which is the exact thing
    // docs/adr/0001 justifies the rule by.
    const violations = checkDependencyDirection([
      { name: "@vibe-vr/capture", dependencies: [], devDependencies: ["playwright-core"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("BrowserSession");
  });

  it("allows a sibling package in devDependencies", () => {
    // docs/adr/0001: @vibe-vr/bench carries siblings as devDependencies for their published
    // fakes, which is what makes the runner unit-testable. Only the *externals* rule
    // widens to devDependencies; the direction rule stays on runtime dependencies.
    const violations = checkDependencyDirection([
      { name: "@vibe-vr/bench", dependencies: ["@vibe-vr/shared"], devDependencies: ["@vibe-vr/sandbox"] },
    ]);
    expect(violations).toEqual([]);
  });

  it("allows the benchmark app to depend on Playwright", () => {
    expect(
      checkDependencyDirection([{ name: "@vibe-vr/napbench", dependencies: ["playwright-core"] }]),
    ).toEqual([]);
  });

  it("rejects the benchmark core reaching past @vibe-vr/shared", () => {
    const violations = checkDependencyDirection([
      { name: "@vibe-vr/bench", dependencies: ["@vibe-vr/runtime"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("may only depend on");
  });

  it("allows apps to depend on any package", () => {
    const violations = checkDependencyDirection([
      { name: "@vibe-vr/api", dependencies: ["@vibe-vr/runtime", "@vibe-vr/shared"] },
    ]);
    expect(violations).toEqual([]);
  });

  it("ignores third-party dependencies", () => {
    expect(
      checkDependencyDirection([{ name: "@vibe-vr/context", dependencies: ["zod", "@vibe-vr/shared"] }]),
    ).toEqual([]);
  });

  it("reports every violation, not just the first", () => {
    const violations = checkDependencyDirection([
      { name: "@vibe-vr/shared", dependencies: ["@vibe-vr/db"] },
      { name: "@vibe-vr/agent", dependencies: ["@vibe-vr/runtime"] },
    ]);
    expect(violations).toHaveLength(2);
  });

  it("fails loudly on an unknown package rather than passing it", () => {
    // Silence on an unrecognised name is how this check would rot.
    const violations = checkDependencyDirection([
      { name: "@vibe-vr/mystery", dependencies: ["@vibe-vr/runtime"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("unknown");
  });
});
