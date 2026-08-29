/**
 * A ratcheting wrapper for expensive integration tests.
 *
 * These tests drive a REAL `codex app-server` (and, for the approval path, spend
 * a model turn), so we don't want them re-running on every `bun test`. `verifyOnce`
 * runs a test only until it first passes, then records a marker and skips it
 * thereafter — a one-way ratchet. Editing the test's body invalidates its marker
 * automatically (the id hashes the body), and deleting a marker (or the whole
 * `.state/` dir) forces a re-run.
 *
 * The same `skipIf` also gates on Codex being installed, so a machine without
 * `codex` (CI) cleanly SKIPS these rather than failing.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "bun:test";

const STATE = join(import.meta.dir, ".state");
const codexReady = Bun.which("codex") !== null;

/**
 * Register a test that runs at most once-until-green.
 *
 * The marker id is `hash(name + fn source)`, so a changed assertion re-runs on
 * its own; a changed shared helper does not (delete `.state/` when that matters).
 * A failing run writes no marker, so it keeps re-running until it passes — the
 * ratchet only advances on success.
 */
export function verifyOnce(name: string, fn: () => Promise<void>, timeoutMs = 180_000): void {
  const id = Bun.hash(name + fn.toString()).toString(16);
  const marker = join(STATE, `${id}.passed`);
  test.skipIf(!codexReady || existsSync(marker))(
    name,
    async () => {
      await fn();
      mkdirSync(STATE, { recursive: true });
      writeFileSync(marker, `${name}\n${new Date().toISOString()}\n`);
    },
    timeoutMs, // real codex spawns + model turns blow past bun's 5s default
  );
}
