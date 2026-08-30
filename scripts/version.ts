#!/usr/bin/env bun
import { $ } from "bun";
import packageJson from "../package.json" with { type: "json" };

/**
 * The version, derived from the repository rather than stored in it.
 *
 * Only the major is committed (in package.json) - it is the one part that is a
 * deliberate decision. Minor is the commit count, so it only ever rises and
 * names exactly one commit. Patch is the CI run number (or a local timestamp),
 * separating two builds of the same commit - a re-run or a manual build - and
 * making a developer build sort after CI's and obviously not one.
 *
 * Lifted from tidewaiter's run.ts, which worked this scheme out.
 */
export async function version(): Promise<string> {
  const major = packageJson.version.split(".")[0];

  // Counted from HEAD, not from a branch name. On Actions the checkout is
  // detached, so `git rev-parse --abbrev-ref HEAD` answers "HEAD", and
  // GITHUB_REF_NAME on a pull request is "123/merge", which is not a rev at
  // all. HEAD is the commit being built in every one of those cases.
  if ((await $`git rev-parse --is-shallow-repository`.quiet()).text().trim() === "true") {
    throw new Error(
      "this is a shallow clone, so the commit count is wrong and so is the version. " +
        "In Actions, checkout with `fetch-depth: 0`.",
    );
  }

  const revisions = (await $`git rev-list --count HEAD`.quiet()).text().trim();
  const build = process.env.GITHUB_RUN_NUMBER ||
    new Date().toISOString().replace(/[-:T]/g, "").split(".")[0];

  return `${major}.${revisions}.${build}`;
}

// Runnable directly so mise's build/release tasks can read the version without
// importing: `bun scripts/version.ts`.
if (import.meta.main) {
  console.log(await version());
}
