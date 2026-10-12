# opencode-glasses

Give a text-only coding model eyes.

You run a strong coding model as your daily driver in [opencode](https://opencode.ai). It writes great code but cannot see images, so pasting a screenshot gets you "I can't view images" (or worse, a confident guess). Switching the whole session to a multimodal model means losing your coding model's context and tools for the rest of the conversation.

This plugin adds a `view_image` tool. When a message contains an image, your coding model calls the tool, a multimodal model *you* pick looks at the image, and the answer comes back as tool output. Your coding model stays in charge: same context, same tools, it just borrowed someone's eyes for one question.

Typical pairing: a strong text-only coding model as default plus a cheap multimodal model for vision, for example `zai-coding-plan/glm-5.3` with `zai-coding-plan/glm-5.3-flash`. Any provider works as long as the vision model supports image input.

## How it works

1. The plugin registers a `view_image` tool for every agent. The vision model is configured on a `vision` agent in your `opencode.json` (OpenCode 2). On OpenCode 1 the plugin injects the agent for you from its options.
2. When the model calls `view_image`, the plugin starts a throwaway session on the `vision` agent, sends it the image plus the question, and waits for the answer.
3. The answer returns as tool output and the throwaway session is deleted.

The tool finds the image on its own: it uses the most recent image in the current session (pastes, attachments), or an explicit file path if you pass one.

This works whether or not your provider errors on images sent to text-only models. GLM coding plan, for example, does not error: `glm-5.3` just answers blind, so there is no failure event for a fallback plugin to catch. A tool call works because the model itself decides to use it.

When a blind model receives an image, opencode typically replaces the image part with a notice like "model does not support image input". The tool description tells your model explicitly that such a notice means an image IS attached and `view_image` can inspect it, so the first pass does not dead-end in "I can't see images".

## Install

### OpenCode 2

Define the `vision` agent with your multimodal model, then add the plugin:

```jsonc
// opencode.json (or ~/.config/opencode/opencode.json)
{
  "agent": {
    "vision": {
      "mode": "all",
      "model": "zai-coding-plan/glm-5.3-flash",
      "variant": "max",
      "description": "Vision specialist for images",
      "prompt": "Answer questions about images tersely and factually based only on what is visible."
    }
  },
  "plugins": [
    { "package": "opencode-glasses@0.2.0", "options": { "agent": "vision" } }
  ]
}
```

Restart opencode. To upgrade later, bump the pinned version and restart. If a pinned release still does not show up, delete `~/.cache/opencode/packages/opencode-glasses*` and restart.

### OpenCode 1 (1.18.29 or newer)

The plugin injects the `vision` agent for you; only the plugin entry and the model are needed:

```jsonc
{
  "plugin": [
    ["opencode-glasses@0.2.0", { "model": "zai-coding-plan/glm-5.3-flash", "variant": "max" }]
  ]
}
```

To run the latest commit straight from GitHub instead of npm (works on both majors):

```jsonc
// OpenCode 2
{ "plugins": [{ "package": "opencode-glasses@git+https://github.com/Biacode/opencode-glasses.git", "options": { "agent": "vision" } }] }

// OpenCode 1
{ "plugin": [["opencode-glasses@git+https://github.com/Biacode/opencode-glasses.git", { "model": "zai-coding-plan/glm-5.3-flash" }]] }
```

## Configuration

### OpenCode 2

| Option | Required | Default | Meaning |
|---|---|---|---|
| `agent` | no | `vision` | Name of the agent (defined in your `agent` config) that runs the vision model. |

The vision model itself is configured on that agent, not in the plugin options. Env var equivalent: `OPENCODE_GLASSES_AGENT`.

If you already have an agent named `vision`, the tool delegates to yours — no separate config needed beyond the plugin entry.

### OpenCode 1

| Option | Required | Default | Meaning |
|---|---|---|---|
| `model` | yes | | Vision model in `provider/model-id` form. Any model with image attachment support. |
| `variant` | no | | Model variant, e.g. `max` on GLM reasoning models. |
| `agent` | no | `vision` | Name of the injected agent. Change it if you already have your own `vision` agent. |

Env vars: `OPENCODE_GLASSES_MODEL`, `OPENCODE_GLASSES_VARIANT`, `OPENCODE_GLASSES_AGENT`. Options win over env vars.

To find a vision model on your setup, run `opencode models <provider> --verbose` and look for `"attachment": true` in the model metadata.

## The image paste gotcha

If you paste a screenshot in a terminal and nothing shows up in the prompt, this is why: in a terminal, `Cmd+V` / `Ctrl+Shift+V` is handled by the terminal emulator itself, which can only paste text. When your clipboard holds only an image, the terminal sends nothing at all.

opencode's TUI binds its own paste to `Ctrl+V`, which reads the system clipboard natively (via `osascript` on macOS, `wl-paste`/`xclip` on Linux) and attaches the image properly. So: screenshot to clipboard, then `Ctrl+V` inside opencode.

## Compared to error-fallback plugins

There is an existing plugin, `opencode-eyes`, that watches for session errors and resends the failed message on the cheapest available vision model. Different approach, different tradeoffs:

- It needs the provider to actually fail when a blind model receives an image. Providers that silently ignore images never trigger it.
- On fallback, the vision model answers your entire message, and it picks the model by cost from what is connected.
- Here, your coding model stays the agent and asks a scoped question ("what does this screenshot show"), and you pick the vision model explicitly, which matters when your vision model rides on a plan you already pay for.

If you want fully automatic whole-message fallback, use opencode-eyes. If you want your coding model to keep driving and only borrow eyes, use this one.

## Development

```sh
bun install
bun test
bun run typecheck
```

To try local changes without publishing, symlink the entry file into the auto-discovered config plugins directory (verified on OpenCode 2.0.x; `plugins` entries pointing at plain directories or files are ignored or rejected):

```sh
ln -sf /absolute/path/to/opencode-glasses/src/index.ts ~/.config/opencode/plugins/glasses.ts
```

The repo also ships `.opencode/plugins/index.ts`, which re-exports the same definition for directory-based discovery where that is supported. On OpenCode 1, point the `plugin` entry at the entry file directly:

```jsonc
{ "plugin": [["/absolute/path/to/opencode-glasses/src/index.ts", { "model": "..." }]] }
```

Set `OPENCODE_GLASSES_DEBUG=1` to log plugin loading and agent injection decisions to stderr.

## License

MIT
