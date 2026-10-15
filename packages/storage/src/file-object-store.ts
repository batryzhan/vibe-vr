/**
 * `ObjectStore` over the local filesystem, one file per key.
 *
 * Local development only: the API otherwise requires R2 credentials at boot,
 * which is the right demand for any deployment and an account too many for
 * trying the app on a laptop. Selected with `VIBE_VR_OBJECT_STORE=local`, never by
 * default — production keeps failing closed without a bucket.
 *
 * Keys map to paths under one base directory, segments split on `/` exactly
 * like object storage. Anything that would escape the base — `..`, absolute
 * paths, empty segments — is refused as `unavailable` rather than resolved,
 * because a key naming a file outside the store is a caller bug the store must
 * not honor. Error mapping mirrors the R2 adapter: absent reads are
 * `not_found`, everything else is `unavailable`, and deleting a missing key
 * succeeds.
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { ObjectStore, ObjectStoreError } from "@vibe-vr/shared/ports/object-store";
import type { Result, VoidResult } from "@vibe-vr/shared/result";

function invalidKey(key: string): ObjectStoreError {
  return { code: "unavailable", message: `refusing key outside the store: ${JSON.stringify(key)}` };
}

export class FileObjectStore implements ObjectStore {
  readonly #baseDir: string;

  constructor(baseDir: string) {
    this.#baseDir = resolve(baseDir);
  }

  /** Exposed for tests and the boot log, so the directory is never a mystery. */
  baseDir(): string {
    return this.#baseDir;
  }

  private resolveKey(key: string): string | undefined {
    if (key === "") return undefined;
    const segments = key.split("/");
    for (const segment of segments) {
      if (segment === "" || segment === "." || segment === "..") return undefined;
    }
    const absolute = resolve(join(this.#baseDir, ...segments));
    if (absolute !== this.#baseDir && !absolute.startsWith(this.#baseDir + sep)) return undefined;
    return absolute;
  }

  async put(key: string, bytes: Uint8Array): Promise<VoidResult<ObjectStoreError>> {
    const path = this.resolveKey(key);
    if (path === undefined) return { ok: false, error: invalidKey(key) };
    try {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, bytes);
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: this.unavailable(error) };
    }
  }

  async get(key: string): Promise<Result<Uint8Array, ObjectStoreError>> {
    const path = this.resolveKey(key);
    if (path === undefined) return { ok: false, error: invalidKey(key) };
    try {
      return { ok: true, value: new Uint8Array(await readFile(path)) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          ok: false,
          error: { code: "not_found", message: `no object at ${JSON.stringify(key)}` },
        };
      }
      return { ok: false, error: this.unavailable(error) };
    }
  }

  async delete(key: string): Promise<VoidResult<ObjectStoreError>> {
    const path = this.resolveKey(key);
    if (path === undefined) return { ok: false, error: invalidKey(key) };
    try {
      await rm(path, { force: true });
      return { ok: true, value: undefined };
    } catch (error) {
      return { ok: false, error: this.unavailable(error) };
    }
  }

  private unavailable(error: unknown): ObjectStoreError {
    return { code: "unavailable", message: error instanceof Error ? error.message : String(error) };
  }
}
