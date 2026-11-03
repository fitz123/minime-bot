# Scoped Codex Fast

Fast requests the Codex `priority` service tier. It does not change the model,
thinking level, authentication, or conversation history. The package starts with
Fast off and does not enable any agent automatically.

An operator can opt one configured agent into its exact Codex model:

```yaml
agents:
  assistant:
    workspaceCwd: /path/to/agent-workspace
    model: openai-codex/gpt-6-astra
    thinking: high
    codexFast:
      provider: openai-codex
      model: gpt-6-astra
```

The opt-in must match the agent's configured model exactly. Other agents,
including those using the same model, are unchanged unless explicitly opted in.
Changing the current model or provider makes the adapter inactive for that
request. Generic delegated subagents never receive this adapter or an inherited
primary-agent identity.

Authenticated Telegram commands use the actual chat/topic binding:

| Command | Effect |
| --- | --- |
| `/fast` or `/fast status` | Show agent, exact model, default, thread override, and effective adapter request intent |
| `/fast on` | Request priority for this thread |
| `/fast off` | Stop this adapter from requesting priority in this thread |
| `/fast inherit` | Remove the thread override and follow the agent/model default |
| `/fast default on` | Request priority by default for this identified agent/model |
| `/fast default off` | Stop default priority requests from this adapter |
| `/fast default status` | Show status without changing preferences |

Telegram `/fast default on` and `/fast default off` require both an actual
private chat and a `dm` binding. Group chats and threads retain per-thread
controls, `/fast status`, and `/fast default status`. Trusted native local
default commands are unchanged.

A new thread inherits its default. Defaults also apply to identified non-chat
consumers: native local Pi sessions, crons running as the agent, and `ask_agent`
requests targeting that agent. Those consumers never inherit the caller's
thread override. A native Pi session with the configured wrapper and trusted
`MINIME_BOT_PI_SESSION_AGENT_ID` supports the same `/fast` command; without an
identified chat it can change only the default. Missing or unknown agent
identity leaves Fast inactive. The existing extension kill switch still applies.

Preferences are stored in control-workspace `data/codex-fast.json`, separately
from session state, and survive `/clean` and restarts. Defaults and overrides
are keyed by agent/provider/model, with actual chat/thread identity for overrides.
Commands write atomically; each request reads preferences and opt-in configuration
again, so warm sessions see changes without restarting. A concurrent writer
causes an explicit retry message; after a crashed writer, an operator may need to
remove the stale `data/codex-fast.json.lock` before retrying.

Independent provider `service_tier` settings are preserved. For example, an
existing `priority` value still requests priority while this adapter's preference
is off; an existing `auto` value prevents this adapter from adding priority even
when its preference is on. Status always describes adapter intent and this
caveat. Backend-granted priority cannot be inferred. No `models.json` is edited.

The request helper is copied from `@llblab/pi-codex-usage@0.13.2` with its MIT
license, shipped at `dist/extensions/pi/codex-fast-LICENSE.md`. The upstream
shared-model toggle and quota-polling composition are not loaded.

For an independent installed-package check, run:

```sh
node node_modules/minime-bot/dist/verify-codex-fast.js
```

The bounded offline verifier checks the resolved Pi versions, loads the real
packaged wrapper, exercises native command routing and a request-hook matrix,
and executes Pi's Codex request builder with a synthetic token, stopping before
transport. It checks unchanged model/reasoning and preserves independent tiers.
All fixture writes go to a disposable temporary directory; configured preferences,
credentials, sessions, and provider endpoints are not accessed. It exits nonzero
on failed assertions. Set `TMPDIR` to select its scratch parent.
