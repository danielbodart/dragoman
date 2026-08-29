#!/usr/bin/env bun
import { $ } from "bun";
import packageJson from "./package.json" with { type: "json" };

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

export async function check() {
  await $`bunx tsc --noEmit`;
}

export async function test(...args: string[]) {
  await $`bun test ${args}`;
}

/**
 * The version reaches the binary as a build-time define rather than a generated
 * file, so nothing is written into src/ that would then show up as a change.
 * src/version.ts falls back when the define is absent, which is what happens
 * under `bun run src/main.ts`.
 */
export async function build(outfile = "dist/dragoman") {
  const v = await version();
  await $`bun build --compile --minify --sourcemap --define ${`DRAGOMAN_VERSION="${v}"`} src/main.ts --outfile ${outfile}`;
  console.log(`built ${outfile} ${v}`);
}

/** The platforms the plugin archive ships a native binary for. */
const PLUGIN_TARGETS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64"] as const;

/**
 * Build the Claude Code plugin archive: one zip carrying all four native
 * binaries, the launcher, and the plugin tree (manifest, .mcp.json, skill,
 * subagent, command).
 *
 * The marketplace `archive` source is a single url+sha256 with no platform
 * dimension, so every platform's binary rides in the one zip; the committed
 * `bin/dragoman` launcher picks the right one at runtime (no network, no Bun).
 * The zip is flat — `.claude-plugin/plugin.json` sits one level deep, as the
 * installer requires — so it is zipped from INSIDE the staging dir.
 *
 * marketplace.json is deliberately NOT included: it is the marketplace catalog
 * (read from the repo on `/plugin marketplace add`), not a plugin file.
 *
 * Prints the archive's sha256 and size — CI feeds those into marketplace.json.
 */
export async function packagePlugin(out = "dist/dragoman-plugin.zip") {
  const v = await version();
  const stage = "dist/plugin";
  await $`rm -rf ${stage}`;
  await $`mkdir -p ${stage}/bin ${stage}/.claude-plugin`;

  for (const t of PLUGIN_TARGETS) {
    await $`bun build --compile --minify --define ${`DRAGOMAN_VERSION="${v}"`} --target=${`bun-${t}`} src/main.ts --outfile ${`${stage}/bin/dragoman-${t}`}`;
  }

  // Stamp the real release version into the shipped manifest (the committed one
  // carries a placeholder; the release build knows the derived version).
  const manifest = JSON.parse(await Bun.file(".claude-plugin/plugin.json").text());
  manifest.version = v;
  await Bun.write(`${stage}/.claude-plugin/plugin.json`, JSON.stringify(manifest, null, 2) + "\n");
  // The plugin's server config lives under packaging/, NOT at the repo root — a
  // repo-root .mcp.json would make Claude Code auto-load (and fail, since
  // CLAUDE_PLUGIN_ROOT is unset) the server for anyone working IN this repo.
  // The archive is assembled here, so it lands at the archive root regardless.
  await $`cp packaging/mcp.json ${`${stage}/.mcp.json`}`;
  await $`cp bin/dragoman ${`${stage}/bin/dragoman`}`;
  await $`cp -r skills agents ${stage}/`;
  await $`chmod -R u+rwX,go+rX ${stage}`;

  await $`rm -f ${out}`;
  const outName = out.split("/").pop()!;
  // Zip from inside the stage so the archive is flat (info-zip preserves the
  // executable bit in the unix external attributes, which the launcher's chmod
  // also backstops if the extractor drops it).
  await $`sh -c ${`cd '${stage}' && zip -q -9 -r '../${outName}' .`}`;

  const bytes = await Bun.file(out).arrayBuffer();
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const mib = (bytes.byteLength / 1048576).toFixed(1);
  console.log(`packaged ${out} ${v} — ${mib} MiB, sha256 ${digest}`);
  return { out, version: v, sha256: digest, bytes: bytes.byteLength };
}

/**
 * Regenerate the committed Codex app-server protocol bindings.
 *
 * The bindings under generated/codex-protocol/ are ts-rs output from the
 * installed `codex` CLI, committed so the build needs no codex present. Rerun
 * this after a codex upgrade; the resulting `git diff` is the protocol change.
 * See generated/codex-protocol/README.md for the pinned version this was last
 * generated against.
 */
export async function regenProtocol(out = "generated/codex-protocol") {
  await $`codex app-server generate-ts --out ${`${out}/ts`} --experimental`;
  await $`codex app-server generate-json-schema --out ${`${out}/schema`} --experimental`;
  const codexVersion = (await $`codex --version`.quiet()).text().trim();
  console.log(`regenerated ${out} from ${codexVersion}`);
}

const commands: Record<string, (...args: string[]) => Promise<unknown>> = {
  version: async () => console.log(await version()),
  check,
  test,
  build,
  package: packagePlugin,
  "regen-protocol": regenProtocol,
};

const [name = "build", ...args] = process.argv.slice(2);
const command = commands[name];

if (!command) {
  console.error(`Error: '${name}' is not a command. Try: ${Object.keys(commands).join(", ")}`);
  process.exit(2);
}

try {
  await command(...args);
} catch (error) {
  console.error(`Error: ${(error as Error).message}`);
  process.exit(1);
}
