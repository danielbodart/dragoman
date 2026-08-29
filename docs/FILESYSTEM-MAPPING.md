# Fine-grained filesystem mapping — design

_The third profile axis. Claude's `sandbox.filesystem.{allow,deny}{Read,Write}` →
the Codex permission profile's `filesystem` table._

Status: **schema locked live against codex-cli 0.150.1** (profile route, no model
turn — see [Probe evidence](#probe-evidence)); mapping designed, build in progress.

Everything here lives **in the permission profile** — the same engine that already
carries scope (`extends`) and network. The deprecated `sandbox` enum / structured
`sandboxPolicy` are not part of this path.

## Why this is the natural next axis, not a bolt-on

The profile already has two axes wired through one renderer: scope (`extends`) and
network (`[permissions.<id>.network]`). Filesystem is the **symmetric third
sub-table** — `[permissions.<id>.filesystem]` — computed once from the merged
settings and written into both managed profiles, exactly as network is. No new
transport, no config-splice change, no change to per-thread selection; the work is
one renderer branch + one pure mapping function. `network` paved the road.

Writable *roots* (cwd + `additionalDirectories`) ride the orthogonal
`runtimeWorkspaceRoots` thread param and are verified working (MIRROR B2). They
define what `:workspace_roots` **is**; this axis *refines* access within/around it.

## Codex schema (codex-cli 0.150.1, verified)

A profile's filesystem rules are a **flat map of path → access**, where access is
one of **`"read"`**, **`"write"`**, **`"deny"`**:

```toml
[permissions.dragoman-workspace]
extends = ":workspace"

# Absolute paths, top-level table:
[permissions.dragoman-workspace.filesystem]
glob_scan_max_depth = 3
"/etc/hosts"            = "read"
"/home/me/.aws"         = "deny"

# Paths relative to the session's writable roots (subpaths + globs):
[permissions.dragoman-workspace.filesystem.":workspace_roots"]
"."                     = "write"
"**/*.env"              = "deny"
"**/*.pem"              = "deny"
"node_modules"          = "read"
```

Enforced semantics (all probe-verified except the write-carve, noted below):

- **`deny` blocks reads *and* writes.** `read` = read-only. `write` = read+write.
- **Narrower (more specific) path wins; `deny` > `write` > `read`.** So a broad
  `"." = "write"` with a `"**/*.env" = "deny"` carve-out works.
- The table **augments** the base scope (does not replace it): under `:workspace`,
  files outside the table keep the base's read/write; the table only refines.
- **Special path tokens** are sub-tables: `:workspace_roots` (session + profile
  roots; supports subpaths — the one we need), plus `:root`, `:minimal`, `:tmpdir`,
  `:slash_tmp` (each `.`-subpath only). `..` traversal is rejected.
- **Globs** (`**/*.env`) are ordinary keys; `glob_scan_max_depth` bounds `**` scans
  on Linux/WSL/Windows.

Two spellings bite: the TOML key is **`filesystem`** (the internal Rust type is
`FileSystemPermissions`, but `file_system` as a TOML key is silently ignored), and
the deny value is **`deny`** (`none` is silently ignored). Both wrong tokens cost a
long probe detour — encoded here so the next reader doesn't repeat it.

## The mapping

Claude's four lists fold onto the three access levels by what each *means*:

| Claude list | Meaning | `filesystem` access |
|---|---|---|
| `allowRead`  | may read here              | `"read"` |
| `allowWrite` | may write here             | `"write"` |
| `denyWrite`  | may read, **not** write    | `"read"` (downgrade, not removal) |
| `denyRead`   | may **not** even read      | `"deny"` |

`denyWrite → "read"` is the subtle one: Claude's "no write, still readable" is
Codex's read-only level, **not** `deny`. `denyRead → "deny"` removes both.

### Conflict fold (same path in ≥2 lists)

Claude semantics: deny wins, and more-restrictive wins. Codex agrees
(`deny > write > read`). Fold per **unique path** in this order (first match wins),
at mirror time — pure and unit-testable — rather than emitting duplicate keys:

`denyRead → deny` ▸ `denyWrite → read` ▸ `allowWrite → write` ▸ `allowRead → read`

Distinct paths are left for Codex to resolve by narrowest-wins.

### Path anchoring

- **absolute** (`/…`) → top-level `[…filesystem]` table key.
- **relative** or **glob without a leading `/`** → the
  `[…filesystem.":workspace_roots"]` sub-table, so the rule stays portable across
  the isolated `CODEX_HOME` and tracks the session's real roots.
- Escape `"`/`\` in keys via the existing `tomlString`.

## Interaction with base scope (what changes behaviour)

- **High value now:** `denyRead`/`denyWrite` — carve secrets out of an otherwise
  open workspace (`**/*.env = "deny"`). Proven to bite (probe 7).
- **High value:** `allowRead`/`allowWrite` for a path **outside** the workspace
  roots — grants access the base scope doesn't.
- **Low/no-op:** `allowRead` inside a `:workspace` root (already readable),
  `allowWrite` inside a writable root. Emit anyway — cost is nil and it keeps the
  mapping total, so a rule means the same thing in every posture (combinatorial
  completeness).

Danger posture (`bypassPermissions`) has **no profile** → these lists don't apply
(it's "no sandbox" by definition), the same carve-out network already has.

## Supersedes an old finding

MIRROR-VERIFICATION B1 ("reads are unrestricted under every sandbox") was true of
the **deprecated sandbox enum**. Under the profile's `filesystem` table, a `deny`
entry **does** block reads (probe 7). `denyRead` is therefore enforceable — it was
only "unsupported" because the enum era couldn't express it.

## Where it plugs in

1. **`settings.ts`** — already parses all four lists into `EffectiveSettings`. **No change.**
2. **`codex-config.ts`** — add `filesystem?: ProfileFilesystem` to `ManagedProfile`
   and a `renderFilesystem` branch emitting `[permissions.<id>.filesystem]` (+ its
   `.":workspace_roots"` sub-table) when non-empty. Purely additive; unit-tested
   against fixture strings like the network branch.
3. **`mirror.ts`** — add `filesystemFor(settings): ProfileFilesystem` (the fold +
   anchoring) and attach it in `profileFor`/`allProfiles` beside `networkFor`. Pure.
4. **`thread-run.ts`** — **no change.** The profile id is already selected per
   thread; richer profile content rides for free.

## Probe evidence

Against codex-cli 0.150.1, isolated `CODEX_HOME`, profile selected via
`command/exec`'s `permissionProfile` (model-free):

- **Read-deny enforced.** `[permissions.p.filesystem]` `"<cwd>/secret.txt" = "deny"`
  under both `:workspace` and `:read-only` → `cat secret.txt` → exit 1 "Permission
  denied"; `cat public.txt` → exit 0. The table augments the base (public stayed
  readable), narrower path wins.
- **Wrong-token silence.** The key `file_system` and the value `none` both loaded
  without error and enforced **nothing** — the source of the earlier "file_system
  loads but semantics unclear" confusion. The enforced tokens are `filesystem` /
  `deny`.

## Remaining probe (ratchet, one model turn)

`command/exec`'s profile mode carries no writable roots, so the **write-carve**
(`denyWrite → "read"` downgrade of a subpath inside a live workspace root) can only
be exercised on the real thread path (`thread/start` `permissions` + `runtimeWorkspaceRoots`).
Lock it with one ratcheted integration turn, mirroring `profile.integration.test.ts`:
grant a workspace root, deny-write a subpath, have Codex try to write both → root
write succeeds, subpath write refused, subpath still readable.

## Fallback

If the write-carve ratchet ever regresses, the read axis (`denyRead`, `allowRead`)
still stands on its own proof, and absent that the profile simply omits the
`filesystem` table — today's verified state (writable roots via
`runtimeWorkspaceRoots`, reads open). No regression path.
