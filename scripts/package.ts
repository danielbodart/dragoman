#!/usr/bin/env bun
import { $ } from "bun";
import { version } from "./version.ts";

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

if (import.meta.main) {
  await packagePlugin(process.argv[2]);
}
