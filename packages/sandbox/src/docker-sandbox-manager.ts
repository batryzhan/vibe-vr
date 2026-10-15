/** Local project sandboxes backed by containers managed through the Docker CLI. */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SandboxInventory, SandboxListing } from "@vibe-vr/shared/ports/sandbox-inventory";
import type {
  ExecOutputHandler,
  ExecResult,
  FileNode,
  Sandbox,
  SandboxError,
  SandboxManager,
} from "@vibe-vr/shared/ports/sandbox-manager";
import type { Result, VoidResult } from "@vibe-vr/shared/result";

const IMAGE = "vibe-vr-local-sandbox:node24";
const CONTAINER_PREFIX = "vibe-vr-";
const MANAGED_LABEL = "vibe-vr.managed";
const PROJECT_LABEL = "vibe-vr.project";
const DEFAULT_PREVIEW_TIMEOUT_MS = 30_000;
const PREVIEW_POLL_MS = 250;
const PREVIEW_PROBE_TIMEOUT_MS = 3_000;
const TEMPLATE_PORT = 5173;
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

type ProcessResult = { exitCode: number; stdout: string; stderr: string };

async function docker(
  args: string[],
  opts: {
    stdin?: string;
    onStdout?: (chunk: string) => void;
    onStderr?: (chunk: string) => void;
  } = {},
): Promise<ProcessResult> {
  return await new Promise<ProcessResult>((resolve, reject) => {
    const proc = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: string[] = [];
    const stderr: string[] = [];
    proc.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      stdout.push(chunk);
      opts.onStdout?.(chunk);
    });
    proc.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr.push(chunk);
      opts.onStderr?.(chunk);
    });
    proc.once("error", reject);
    proc.once("close", (code) =>
      resolve({ exitCode: code ?? 1, stdout: stdout.join(""), stderr: stderr.join("") }),
    );
    proc.stdin.end(opts.stdin);
  });
}

function failure(code: SandboxError["code"], message: string): { ok: false; error: SandboxError } {
  return { ok: false, error: { code, message } };
}

function dockerFailure(
  result: ProcessResult,
  missingCode: SandboxError["code"] = "unavailable",
): SandboxError {
  const message =
    result.stderr.trim() || result.stdout.trim() || `docker exited ${result.exitCode}`;
  if (/no such (container|object)|container .* not found/i.test(message)) {
    return { code: "not_found", message };
  }
  if (/no such file or directory/i.test(message)) return { code: missingCode, message };
  return { code: "unavailable", message };
}

/**
 * Docker implementation of the project sandbox port. Each project gets its own
 * resource-limited container, image, writable layer and localhost-only preview port.
 */
export class DockerSandboxManager implements SandboxManager, SandboxInventory {
  readonly #destroyed = new Set<string>();
  readonly #host = "127.0.0.1";
  #imageReady: Promise<void> | undefined;

  /** Check the local Docker daemon without creating a container. */
  async ping(): Promise<void> {
    const result = await docker(["info", "--format", "{{.ServerVersion}}"]);
    if (result.exitCode !== 0)
      throw new Error(result.stderr.trim() || "Docker daemon is unavailable");
    if (result.stdout.trim() === "") throw new Error("Docker daemon returned no server version");
  }

  async create(projectId: string): Promise<Result<Sandbox, SandboxError>> {
    const id = `${CONTAINER_PREFIX}${createHash("sha256").update(projectId).digest("hex").slice(0, 32)}`;
    try {
      await this.#ensureImage();
      const result = await docker([
        "run",
        "--detach",
        "--init",
        "--name",
        id,
        "--label",
        `${MANAGED_LABEL}=true`,
        "--label",
        `${PROJECT_LABEL}=${projectId}`,
        "--memory",
        "1g",
        "--cpus",
        "1.5",
        "--pids-limit",
        "256",
        "--security-opt",
        "no-new-privileges:true",
        "--cap-drop",
        "ALL",
        "--publish",
        `127.0.0.1::${TEMPLATE_PORT}/tcp`,
        IMAGE,
      ]);
      if (result.exitCode !== 0) return failure("unavailable", dockerFailure(result).message);
      this.#destroyed.delete(id);
      const preview = await this.#startPreview(id);
      if (!preview.ok) {
        await docker(["rm", "--force", id]);
        return { ok: false, error: preview.error };
      }
      return { ok: true, value: { id, projectId } };
    } catch (cause) {
      return failure("unavailable", cause instanceof Error ? cause.message : String(cause));
    }
  }

  async resume(sandboxId: string): Promise<Result<Sandbox, SandboxError>> {
    const tombstone = this.#tombstone(sandboxId);
    if (tombstone !== undefined) return tombstone;
    const inspected = await docker([
      "inspect",
      "--format",
      `{{.State.Running}}\t{{index .Config.Labels "${PROJECT_LABEL}"}}`,
      sandboxId,
    ]);
    if (inspected.exitCode !== 0) return failure("not_found", dockerFailure(inspected).message);
    const [running, projectId] = inspected.stdout.trim().split("\t");
    if (projectId === undefined || projectId === "<no value>" || projectId === "") {
      return failure("not_found", `container ${sandboxId} is not a Vibe-VR project sandbox`);
    }
    if (running !== "true") {
      const started = await docker(["start", sandboxId]);
      if (started.exitCode !== 0) return failure("unavailable", dockerFailure(started).message);
      const preview = await this.#startPreview(sandboxId);
      if (!preview.ok) return { ok: false, error: preview.error };
    }
    return { ok: true, value: { id: sandboxId, projectId } };
  }

  async destroy(sandboxId: string): Promise<VoidResult<SandboxError>> {
    const tombstone = this.#tombstone(sandboxId);
    if (tombstone !== undefined) return tombstone;
    const inspected = await docker([
      "inspect",
      "--format",
      `{{index .Config.Labels "${MANAGED_LABEL}"}}`,
      sandboxId,
    ]);
    if (inspected.exitCode !== 0) return failure("not_found", dockerFailure(inspected).message);
    if (inspected.stdout.trim() !== "true") {
      return failure("not_found", `container ${sandboxId} is not managed by Vibe-VR`);
    }
    const removed = await docker(["rm", "--force", sandboxId]);
    if (removed.exitCode !== 0) return failure("unavailable", dockerFailure(removed).message);
    this.#destroyed.add(sandboxId);
    return { ok: true, value: undefined };
  }

  /** Containers live until the idle reaper stops them; Docker has no provider TTL. */
  async extendTimeout(sandboxId: string, _ms: number): Promise<VoidResult<SandboxError>> {
    const resumed = await this.resume(sandboxId);
    return resumed.ok ? { ok: true, value: undefined } : { ok: false, error: resumed.error };
  }

  async writeFile(
    sandboxId: string,
    path: string,
    contents: string,
  ): Promise<VoidResult<SandboxError>> {
    const tombstone = this.#tombstone(sandboxId);
    if (tombstone !== undefined) return tombstone;
    const result = await docker(
      [
        "exec",
        "--interactive",
        sandboxId,
        "sh",
        "-c",
        'mkdir -p -- "$(dirname "$1")" && cat > "$1"',
        "sh",
        path,
      ],
      { stdin: contents },
    );
    return result.exitCode === 0
      ? { ok: true, value: undefined }
      : { ok: false, error: dockerFailure(result) };
  }

  async readFile(sandboxId: string, path: string): Promise<Result<string, SandboxError>> {
    const tombstone = this.#tombstone(sandboxId);
    if (tombstone !== undefined) return tombstone;
    const result = await docker(["exec", sandboxId, "cat", "--", path]);
    return result.exitCode === 0
      ? { ok: true, value: result.stdout }
      : { ok: false, error: dockerFailure(result, "file_not_found") };
  }

  async listFiles(sandboxId: string, path: string): Promise<Result<FileNode[], SandboxError>> {
    const tombstone = this.#tombstone(sandboxId);
    if (tombstone !== undefined) return tombstone;
    const result = await docker([
      "exec",
      sandboxId,
      "find",
      path,
      "-mindepth",
      "1",
      "-maxdepth",
      "1",
      "-printf",
      "%y\\t%p\\n",
    ]);
    if (result.exitCode !== 0) return { ok: false, error: dockerFailure(result, "file_not_found") };
    const files = result.stdout
      .split("\n")
      .filter((line) => line !== "")
      .map((line): FileNode => {
        const tab = line.indexOf("\t");
        return {
          type: line.slice(0, tab) === "d" ? "directory" : "file",
          path: line.slice(tab + 1),
        };
      });
    return { ok: true, value: files };
  }

  async exec(
    sandboxId: string,
    command: string,
    onOutput?: ExecOutputHandler,
  ): Promise<Result<ExecResult, SandboxError>> {
    const tombstone = this.#tombstone(sandboxId);
    if (tombstone !== undefined) return tombstone;
    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await docker(["exec", sandboxId, "sh", "-lc", command], {
      onStdout: (data) => {
        stdout.push(data);
        onOutput?.({ stream: "stdout", data });
      },
      onStderr: (data) => {
        stderr.push(data);
        onOutput?.({ stream: "stderr", data });
      },
    });
    if (/no such (container|object)|container .* not found/i.test(result.stderr)) {
      return { ok: false, error: dockerFailure(result) };
    }
    return {
      ok: true,
      value: { exitCode: result.exitCode, stdout: stdout.join(""), stderr: stderr.join("") },
    };
  }

  async getPreviewUrl(sandboxId: string, port: number): Promise<Result<string, SandboxError>> {
    const tombstone = this.#tombstone(sandboxId);
    if (tombstone !== undefined) return tombstone;
    if (port !== TEMPLATE_PORT) {
      return failure(
        "unavailable",
        `local sandbox exposes preview port ${TEMPLATE_PORT}, not ${port}`,
      );
    }
    const result = await docker(["port", sandboxId, `${port}/tcp`]);
    if (result.exitCode !== 0) return { ok: false, error: dockerFailure(result) };
    const match = /(?:127\.0\.0\.1|0\.0\.0\.0|\[::\]):(\d+)/.exec(result.stdout.trim());
    if (match?.[1] === undefined)
      return failure("unavailable", `Docker did not publish port ${port}`);
    return { ok: true, value: `http://${this.#host}:${match[1]}` };
  }

  async waitForPreview(
    sandboxId: string,
    port: number,
    opts?: { timeoutMs?: number },
  ): Promise<Result<string, SandboxError>> {
    const url = await this.getPreviewUrl(sandboxId, port);
    if (!url.ok) return url;
    const deadline = Date.now() + (opts?.timeoutMs ?? DEFAULT_PREVIEW_TIMEOUT_MS);
    let lastReason = "no response";
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url.value, {
          redirect: "follow",
          signal: AbortSignal.timeout(Math.min(PREVIEW_PROBE_TIMEOUT_MS, deadline - Date.now())),
        });
        if (response.ok) return { ok: true, value: url.value };
        lastReason = `HTTP ${response.status}`;
      } catch (cause) {
        lastReason = cause instanceof Error ? cause.message : String(cause);
      }
      const remaining = deadline - Date.now();
      if (remaining > 0)
        await new Promise((resolve) => setTimeout(resolve, Math.min(PREVIEW_POLL_MS, remaining)));
    }
    return failure("timeout", `preview at ${url.value} did not become ready (last: ${lastReason})`);
  }

  async list(): Promise<Result<SandboxListing[], SandboxError>> {
    const result = await docker([
      "ps",
      "--format",
      "{{.Names}}",
      "--filter",
      `label=${MANAGED_LABEL}=true`,
    ]);
    if (result.exitCode !== 0) return { ok: false, error: dockerFailure(result) };
    const ids = result.stdout.trim().split("\n").filter(Boolean);
    const listings: SandboxListing[] = [];
    for (const id of ids) {
      const inspected = await docker([
        "inspect",
        "--format",
        `{{index .Config.Labels "${PROJECT_LABEL}"}}\t{{.State.StartedAt}}`,
        id,
      ]);
      if (inspected.exitCode !== 0) return { ok: false, error: dockerFailure(inspected) };
      const [projectId, startedAt] = inspected.stdout.trim().split("\t");
      if (startedAt === undefined) continue;
      listings.push({
        id,
        projectId: projectId === undefined || projectId === "<no value>" ? null : projectId,
        startedAt: new Date(startedAt).toISOString(),
      });
    }
    return { ok: true, value: listings };
  }

  async #ensureImage(): Promise<void> {
    this.#imageReady ??= (async () => {
      const inspected = await docker(["image", "inspect", IMAGE]);
      if (inspected.exitCode === 0) return;
      const built = await docker([
        "build",
        "--tag",
        IMAGE,
        "--file",
        join(PACKAGE_ROOT, "Dockerfile"),
        PACKAGE_ROOT,
      ]);
      if (built.exitCode !== 0) {
        throw new Error(
          `Could not build local sandbox image: ${built.stderr.trim() || built.stdout.trim()}`,
        );
      }
    })();
    try {
      await this.#imageReady;
    } catch (cause) {
      this.#imageReady = undefined;
      throw cause;
    }
  }

  async #startPreview(sandboxId: string): Promise<VoidResult<SandboxError>> {
    const started = await docker(["exec", "--detach", sandboxId, "bun", "run", "dev"]);
    if (started.exitCode !== 0) return failure("unavailable", dockerFailure(started).message);
    const ready = await this.waitForPreview(sandboxId, TEMPLATE_PORT);
    return ready.ok ? { ok: true, value: undefined } : { ok: false, error: ready.error };
  }

  #tombstone(sandboxId: string): { ok: false; error: SandboxError } | undefined {
    return this.#destroyed.has(sandboxId)
      ? { ok: false, error: { code: "destroyed", message: `sandbox ${sandboxId} was destroyed` } }
      : undefined;
  }
}
