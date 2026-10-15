/** Exercises the sandbox contract against actual local Docker containers. */

import { afterAll, expect } from "vitest";
import { DockerSandboxManager } from "./docker-sandbox-manager.ts";
import { describeSandboxManagerConformance } from "./testing/conformance.ts";

const created = new Set<string>();

describeSandboxManagerConformance({
  name: "DockerSandboxManager",
  root: "/home/user",
  commands: {
    streamsOutput: "printf 'one\\n'; printf 'two\\n' >&2",
    failsWithCode3: "exit 3",
  },
  unknownSandboxId: () => `vibe-vr-missing-${crypto.randomUUID().replaceAll("-", "")}`,
  createManager: async () => {
    const inner = new DockerSandboxManager();
    const sandboxIds: string[] = [];
    return {
      manager: {
        create: async (projectId) => {
          const result = await inner.create(projectId);
          if (result.ok) {
            sandboxIds.push(result.value.id);
            created.add(result.value.id);
          }
          return result;
        },
        resume: (id) => inner.resume(id),
        destroy: (id) => inner.destroy(id),
        extendTimeout: (id, ms) => inner.extendTimeout(id, ms),
        writeFile: (id, path, contents) => inner.writeFile(id, path, contents),
        readFile: (id, path) => inner.readFile(id, path),
        listFiles: (id, path) => inner.listFiles(id, path),
        exec: (id, command, onOutput) => inner.exec(id, command, onOutput),
        getPreviewUrl: (id, port) => inner.getPreviewUrl(id, port),
        waitForPreview: (id, port, opts) => inner.waitForPreview(id, port, opts),
      },
      cleanup: async () => {
        await Promise.all(
          sandboxIds.map(async (id) => {
            await inner.destroy(id);
            created.delete(id);
          }),
        );
      },
    };
  },
});

afterAll(async () => {
  const inventory = await new DockerSandboxManager().list();
  const stillRunning = inventory.ok ? inventory.value.filter((item) => created.has(item.id)) : [];
  expect(stillRunning, `local Docker sandboxes left running: ${stillRunning.join(", ")}`).toEqual(
    [],
  );
});
