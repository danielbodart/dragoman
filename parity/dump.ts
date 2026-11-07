// Parity dump, TypeScript side: for each fixture and posture, what the mirror
// compiles and what codex-home writes.
import { mkdtempSync, readFileSync, readlinkSync, readdirSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mirror, resolveMode } from "../src/mirror.ts";
import { renderManagedBlock, renderRules } from "../src/codex-config.ts";
import { ensureCodexHome } from "../src/codex-home.ts";

const fixtures = JSON.parse(readFileSync(join(import.meta.dir, "fixtures.json"), "utf8"));
const postures = [undefined, "plan", "default", "manual", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "nonsense"];
const out: unknown[] = [];
for (const f of fixtures) {
  const s = { allow: [], deny: [], ask: [], additionalDirectories: [], denyRead: [], denyWrite: [], allowRead: [], allowWrite: [], allowedDomains: [], deniedDomains: [], ...f };
  for (const p of postures) {
    const mode = resolveMode(s, p);
    const policy = mirror(s, mode);
    const root = mkdtempSync(join(tmpdir(), "parity-"));
    const real = join(root, "real");
    mkdirSync(real);
    writeFileSync(join(real, "auth.json"), "{}");
    writeFileSync(join(real, "config.toml"), 'model = "x"\n');
    const home = ensureCodexHome(policy.profile ? [policy.profile] : [], { realHome: real, isolatedHome: join(root, "home"), sharedStore: join(root, "shared") }, renderRules(policy.execpolicyAmendments, policy.denyPrefixes));
    const files: Record<string, string> = {};
    for (const name of readdirSync(home).sort()) {
      const path = join(home, name);
      files[name] = lstatSync(path).isSymbolicLink() ? "-> " + readlinkSync(path).replace(root, "$ROOT") : lstatSync(path).isDirectory() ? "dir" : readFileSync(path, "utf8");
    }
    let rules = "";
    try { rules = readFileSync(join(home, "rules", "dragoman.rules"), "utf8"); } catch {}
    out.push({
      fixture: f, posture: p ?? null, mode,
      approvalPolicy: policy.approvalPolicy, reviewer: policy.approvalsReviewer ?? "", commandFallback: policy.commandFallback, fileChange: policy.fileChange,
      amendments: policy.execpolicyAmendments, deny: policy.denyPrefixes, collaborationMode: policy.collaborationMode ?? "",
      block: renderManagedBlock(policy.profile ? [policy.profile] : []), files, rules,
    });
  }
}
console.log(JSON.stringify(out, null, 1));
