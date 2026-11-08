# Shared behavioral foundation

The private Main-owned publisher supplies an immutable directory containing
`manifest.json` and the complete shared rules, workflows and skill assets. This
package only consumes publications; it does not select private sources or publish.

## Version 1 publication contract

```json
{
  "version": 1,
  "revision": "example-revision-1",
  "rules": [
    {"path": "rules/coding.md", "source": ".claude/rules/platform/coding.md"}
  ],
  "skills": [{
    "path": "skills/example-workflow",
    "name": "example-workflow",
    "source": ".claude/skills/example-workflow"
  }],
  "files": {
    "rules/coding.md": "<64 lowercase hex SHA-256 characters>",
    "skills/example-workflow/SKILL.md": "<64 lowercase hex SHA-256 characters>",
    "skills/example-workflow/support.md": "<64 lowercase hex SHA-256 characters>"
  },
  "sourceOwnerAgentIds": ["source-owner"]
}
```

Paths are normalized relative POSIX paths with no `.` or `..` segments. Rule
sources are stable identities under `.claude/rules/`, ending in `.md`; published
paths need not match those identities. Each rule and every file in each skill
directory must be listed and hashed. Skills have a native Pi `SKILL.md` with a
matching name and nonempty description. Rule identities and skill names are unique.
Each skill may declare an optional, unique `source` directory identity:
`.claude/skills/<dir>` or `.pi/skills/<dir>`. The publisher
should set `skill.source` for promoted local skills retained in the source owner's
workspace. It identifies the original local directory, independently of the
published `path` or native skill `name`; it is not a path to read from the source
owner's workspace. Omitting it preserves version 1 compatibility but does not
authorize excluding any local directory. Declared identities contribute to the
publication digest.
All files and skill assets resolve inside the publication. Outside symlinks are
errors. Manifest hashes are integrity/identity evidence, not publisher authentication.
The trusted parent chooses the publication root.
Eager workflow instructions are `rules` entries; progressively disclosed workflows
are skills with their support files. `files` is the integrity inventory and does
not independently add prompt content.
The machine-readable shape is [shared-behavior.schema.json](shared-behavior.schema.json);
the loader additionally checks file existence, hashes, containment and identities.

## Deployment configuration

```yaml
behavioralFoundation:
  root: /example/shared-behavior/current
```

This optional deployment-global setting enrolls every configured agent, including
future agents. It is not an agent setting. A separate instance overlay may repeat
the exact canonical value but cannot remove or replace it. Without the setting,
existing loading behavior is preserved. A configured publication is required:
missing, invalid or corrupt resources stop launch with an error.

Rules apply when relevant; local rules supplement and cannot cancel the published
foundation. Skill availability grants no permission to act. Local USER, persona,
Knowledge and companion context stay local and private. Source-owner agents omit
local promoted rule files and exact skill source directories by declared source
identity before reading or traversing them, so unpublished edits do not replace or
block the publication. Only agents listed in `sourceOwnerAgentIds` receive this
exclusion. Other local skills remain available; byte equality never grants an
exclusion. Other agents must remove same-identity local rules. Same-name local
skills, including source-owner additions outside declared directories, are rejected
visibly. The legacy external `platform` directory link is ignored when an explicit
publication is configured, without looking up or reading Main's workspace.
External or dangling whole `.claude/skills` and `.pi/skills` root symlinks are
replaced by the selected publication with a visible warning. Only root symlink
resolution is used to determine containment; legacy target contents and central
config are not read. Contained root links and local additions still load. Escapes
in unignored child skill assets and local rule files/directories remain errors.
This replacement never makes the publication optional, and unconfigured behavior
is unchanged.

Configured native Pi loading disables ambient skill discovery and passes explicit
shared `SKILL.md` file paths first (so directory ignore files cannot hide a
required skill), followed by contained local additions from `.claude/skills`
and `.pi/skills`. Pi retains native skill metadata and progressive disclosure,
including relative support files. Local asset traversal skips native hidden,
`node_modules` and ignored trees; publication assets are always checked in full.
Aliases to the same real skill file are deduplicated before name conflicts.
Global/home skill trees are not added.
Native metadata warnings for skills Pi successfully loads (such as portability
warnings about name characters or description length) remain visible without
blocking launch. Malformed local skills retain native warning-and-skip behavior;
required published skill failures, containment violations and name collisions
remain fatal.

The root (including a `current` symlink) is resolved once per context load to its
physical revision directory. Rule bytes and skill advertisements use that same
revision. Publishers must never mutate a revision and must retain old revisions.
A new managed load observes a new publication; active sessions retain their old
files. Existing restart/update lifecycle owns refresh. There is no watcher, daemon,
consumer database or garbage collection here. Digest-named context artifacts are
also intentionally retained: deleting them could break active reloads or parallel
contexts. Artifact accumulation remains an unbounded retention limitation.

## Parent launcher adaptation

The stable ESM entrypoint is `minime-bot/shared-behavior`. The private uppercase PI
launcher uses the same assembler and native argument builder as managed launchers:

```js
import {
  assemblePiContext,
  piContextResourceArgs,
  MINIME_BEHAVIORAL_FOUNDATION_ROOT_ENV,
} from "minime-bot/shared-behavior";

// All variables below are explicit trusted launcher inputs, not model arguments.
const context = assemblePiContext(
  { id: agentId, workspaceCwd: agentWorkspace, model },
  { behavioralFoundationRoot: canonicalRoot, artifactWorkspaceCwd: instanceStateRoot },
);
if (!context?.behavioralFoundation) throw new Error("Required foundation was not loaded");
const args = [...basePiArgs, ...piContextResourceArgs(context)];
const env = {
  ...allowedPiEnv,
  [MINIME_BEHAVIORAL_FOUNDATION_ROOT_ENV]: context.behavioralFoundation.root,
};
// Spawn only after assembly succeeds. Propagate errors; do not retry with less context.
```

`assemblePiContext` reads the selected agent's contained local context and persona;
the optional `systemPrompt` agent field can also supply an existing persona. It
preserves ordinary local warning-and-skip semantics unless `strict: true` is
explicitly requested (as workers do), including a missing optional output-style.
Configured loads bypass legacy central config and signature discovery in either
mode. The assembler returns private artifact paths, `manifest` (hash-only identity), and
`behavioralFoundation: {root, digest, skillPaths}`. `piContextResourceArgs` supplies
the system/append prompt flags, context suppression and explicit skill arguments.
Do not add ambient/global skill paths. Do not catch foundation errors and launch
with reduced context. Use the returned physical root for the child environment;
never copy `current` into that environment. This environment key is a trusted
adapter contract, not a configuration override for managed top-level agents.

Lower-level consumers may use `resolveBehavioralFoundation(root)` directly. It
returns `{root, manifest, digest, rules, skillPaths}`; `renderBehavioralFoundation`
renders the authority guidance and published rules. The resolver reads only its
explicit publication root and has no config discovery or cache. Context loads
include a `shared:behavioral-foundation-v1` source with its hash-only digest.
`resolveFoundationSkillPaths(foundation, workspace, agentId)` selects published
skills followed by local additions, applying source-owner exclusions for the
explicit agent ID. It emits native metadata and legacy replacement warnings.

Native subagents use `assemblePiSubagentFoundation(root, artifactWorkspace, roleId,
rolePrompt)` plus `piContextResourceArgs`. This reads no parent CLAUDE, USER,
persona or Knowledge files, and selects only published skills. The parent passes
the pinned root through `MINIME_BEHAVIORAL_FOUNDATION_ROOT`. Delegated role and task
remain explicit inputs. Interactive, cron and ask-agent loads retain the selected
agent's own local context and legitimate contained skill additions.

Workers receive `behavioralFoundationRoot?: string` in their fixed version 1
descriptor. This is a nonsecret absolute publication path (it may name `current`).
Each lane load pins it and supplies the same resource arguments and physical-root
environment through prepared Pi spawning. Workers never read central control
config to discover the root, including when a legacy platform link exists. The
resolved `AgentConfig.behavioralFoundationRoot` field is an internal deployment
adapter value; config validation rejects it on individual agents.

This repository does not edit or install the private launcher or publisher.
