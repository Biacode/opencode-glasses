# opencode-glasses

Give a text-only coding model eyes.

You run a strong coding model as your daily driver in [opencode](https://opencode.ai). It writes great code but cannot see images, so pasting a screenshot gets you "I can't view images" (or worse, a confident guess). Switching the whole session to a multimodal model means losing your coding model's context and tools for the rest of the conversation.

This plugin adds a `view_image` tool. When a message contains an image, your coding model calls the tool, a multimodal model *you* pick looks at the image, and the answer comes back as tool output. Your coding model stays in charge: same context, same tools, it just borrowed someone's eyes for one question.

Typical pairing: a strong text-only coding model as default plus a cheap multimodal model for vision, for example `zai-coding-plan/glm-5.3` with `zai-coding-plan/glm-5.3-flash`. Any provider works as long as the vision model supports image input.

## How it works

1. On startup the plugin injects a `vision` agent configured with your vision model, and registers the `view_image` tool for every agent.
2. When the model calls `view_image`, the plugin starts a throwaway session on the `vision` agent, sends it the image plus the question, and waits for the answer.
3. The answer returns as tool output and the throwaway session is deleted.

The tool finds the image on its own: it uses the most recent image in the current session (pastes, attachments), or an explicit file path if you pass one.

This works whether or not your provider errors on images sent to text-only models. GLM coding plan, for example, does not error: `glm-5.3` just answers blind, so there is no failure event for a fallback plugin to catch. A tool call works because the model itself decides to use it.

When a blind model receives an image, opencode typically replaces the image part with a notice like "model does not support image input". The tool description tells your model explicitly that such a notice means an image IS attached and `view_image` can inspect it, so the first pass does not dead-end in "I can't see images".

## Install

Pin the version. opencode caches installed plugins under `~/.cache/opencode/packages/` and does not always pick up new releases on its own, so an unpinned entry can leave you stuck on an old copy without any error.

```jsonc
// opencode.json (or ~/.config/opencode/opencode.json)
{
  "plugin": [
    ["opencode-glasses@0.1.2", { "model": "zai-coding-plan/glm-5.3-flash", "variant": "max" }]
  ]
}
```

Restart opencode. That is the whole setup: the plugin installs the agent and the tool for you. To upgrade later, bump the pinned version and restart. If a pinned release still does not show up, delete `~/.cache/opencode/packages/opencode-glasses*` and restart.

To run the latest commit straight from GitHub instead of npm:

```jsonc
{
  "plugin": [
    ["opencode-glasses@git+https://github.com/Biacode/opencode-glasses", { "model": "zai-coding-plan/glm-5.3-flash" }]
  ]
}
```

## Configuration

| Option | Required | Default | Meaning |
|---|---|---|---|
| `model` | yes | | Vision model in `provider/model-id` form. Any model with image attachment support. |
| `variant` | no | | Model variant, e.g. `max` on GLM reasoning models. |
| `agent` | no | `vision` | Name of the injected agent. Change it if you already have your own `vision` agent. |

Instead of options you can set environment variables: `OPENCODE_GLASSES_MODEL`, `OPENCODE_GLASSES_VARIANT`, `OPENCODE_GLASSES_AGENT`. Options win over env vars.

To find a vision model on your setup, run `opencode models <provider> --verbose` and look for `"attachment": true` in the model metadata.

If you already have an agent named `vision`, the plugin does not touch it and the tool delegates to yours. That is the escape hatch for full control over the vision agent's prompt or permissions.

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

To try local changes without publishing, point your `plugin` entry at the source file inside your checkout (the file, not the repo folder; directory paths currently fail to load silently):

```jsonc
{ "plugin": [["/absolute/path/to/opencode-glasses/src/index.ts", { "model": "..." }]] }
```

Set `OPENCODE_GLASSES_DEBUG=1` to log plugin loading and agent injection decisions to stderr.

## License

MIT
