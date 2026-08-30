#!/usr/bin/env bun
import { $ } from "bun";
import { version } from "./version.ts";

/**
 * Build the Claude Code plugin archive: one small zip carrying the bundled
 * server JS plus the plugin tree (manifest, .mcp.json, hooks, skills, agents).
 *
 * The server ships as a single `bun build` bundle (deps inlined, ~280 KB), NOT
 * a native `--compile` binary. The binary embedded the whole Bun runtime (~30
 * MB) per platform, so the archive was ~116 MB and every plugin update was a
 * slow, feedback-less download. The bundle needs `bun` on the user's PATH at
 * runtime (a SessionStart hook warns when it is missing) but is one
 * cross-platform file - so no per-platform matrix and no launcher.
 *
 * The marketplace `archive` source is a single url+sha256; the whole plugin
 * rides in this one zip, flat (`.claude-plugin/plugin.json` sits one level
 * deep, as the installer requires), so it is zipped from INSIDE the stage dir.
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
  await $`mkdir -p ${stage}/dist ${stage}/scripts ${stage}/.claude-plugin`;

  // One bundled, self-contained JS (deps inlined; no node_modules at runtime).
  // --target=bun so the Node/Bun built-ins the MCP SDK imports resolve - the
  // bundler's browser default drops them. The version rides in as a build-time
  // define, same as before; src/version.ts falls back when it is absent.
  await $`bun build --target=bun --minify --define ${`DRAGOMAN_VERSION="${v}"`} src/main.ts --outfile ${`${stage}/dist/dragoman.js`}`;

  // Stamp the real release version into the shipped manifest (the committed one
  // carries a placeholder; the release build knows the derived version).
  const manifest = JSON.parse(await Bun.file(".claude-plugin/plugin.json").text());
  manifest.version = v;
  await Bun.write(`${stage}/.claude-plugin/plugin.json`, JSON.stringify(manifest, null, 2) + "\n");

  // Shipped plugin assets live under packaging/ so nothing is loaded for anyone
  // working IN this repo (a repo-root .mcp.json would make Claude Code auto-load
  // - and fail - the server, since CLAUDE_PLUGIN_ROOT is unset here). They land
  // at the archive root, where the installed plugin expects them.
  await $`cp packaging/mcp.json ${`${stage}/.mcp.json`}`;
  await $`cp packaging/hooks.json ${`${stage}/hooks.json`}`;
  await $`cp packaging/check-dependencies.sh ${`${stage}/scripts/check-dependencies.sh`}`;
  await $`cp packaging/inject-posture.sh ${`${stage}/scripts/inject-posture.sh`}`;
  await $`cp -r skills agents ${stage}/`;
  await $`chmod -R u+rwX,go+rX ${stage}`;

  await $`rm -f ${out}`;
  const outName = out.split("/").pop()!;
  // Zip from inside the stage so the archive is flat (info-zip preserves the
  // executable bit in the unix external attributes, which matters for the hook
  // script).
  await $`sh -c ${`cd '${stage}' && zip -q -9 -r '../${outName}' .`}`;

  const bytes = await Bun.file(out).arrayBuffer();
  const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const kib = (bytes.byteLength / 1024).toFixed(0);
  console.log(`packaged ${out} ${v} — ${kib} KiB, sha256 ${digest}`);
  return { out, version: v, sha256: digest, bytes: bytes.byteLength };
}

if (import.meta.main) {
  await packagePlugin(process.argv[2]);
}
