import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import nodePath from "node:path"
import { Plugin } from "@opencode/plugin"
import { tool, type Plugin as V1Plugin } from "@opencode-ai/plugin"

/**
 * V2 context: the plugin context passed to setup(ctx).
 * Derived from the runtime type so this file stays in sync with @opencode/plugin.
 */
type V2Context = Parameters<Plugin.Plugin["setup"]>[0]

/** Options accepted by the V2 entrypoint (the `options` object in `plugins`). */
type Options = {
  /** Agent name to delegate image inspection to. Defaults to "vision". */
  agent?: string
}

/** Options accepted by the V1 entrypoint. */
type V1Options = {
  /** Vision model in "provider/model-id" form, e.g. "zai-coding-plan/glm-5.3-flash". */
  model?: string
  /** Optional model variant, e.g. "max". */
  variant?: string
  /** Agent name to inject and delegate to. Defaults to "vision". */
  agent?: string
}

const ENV_MODEL = "OPENCODE_GLASSES_MODEL"
const ENV_VARIANT = "OPENCODE_GLASSES_VARIANT"
const ENV_AGENT = "OPENCODE_GLASSES_AGENT"
const DEFAULT_AGENT = "vision"
const TIMEOUT_MS = 180_000

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
}

const AGENT_PROMPT = `You are the vision specialist for this opencode setup. You run on the configured multimodal model; every other agent runs a text-only coding model and cannot perceive images. You are the one who can.

When you receive an image with a question:

- Answer the question precisely based only on what is actually visible.
- Transcribe text in the image verbatim when it matters (error messages, labels, code).
- Describe layout, colors, and UI state concretely; never guess beyond what you see.
- Be terse and factual. No preamble, no follow-up questions unless the image is unreadable.`

const AGENT_DESCRIPTION =
  "Vision specialist for images. Reads screenshots, photos, diagrams, and UI captures with the configured multimodal model; text-only agents delegate their image questions here. Switch to it directly when a conversation is mostly about images."

const TOOL_DESCRIPTION =
  "Inspect an image using the multimodal vision model. The current coding model cannot see images. Use this tool EVERY time a message includes a pasted or attached image (screenshot, photo, diagram, chart, UI capture) and the answer requires seeing its content: reading text inside it, describing layout, colors, or visual state. This includes messages where an image part was replaced by a notice or error saying the model does not support image input: that notice means an image IS attached and this tool can still inspect it. You may call this tool repeatedly, e.g. to ask follow-up questions about the same image. NEVER tell the user to save an image to a file or provide a path; the session's images are directly accessible to this tool. Returns the vision model's textual answer. Optionally pass a file path; without one, the most recent image in this session is inspected."

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function debugLog(message: string) {
  if (process.env.OPENCODE_GLASSES_DEBUG === "1") console.error(`[opencode-glasses] ${message}`)
}

function v1ConfigHelp(reason: string) {
  return `opencode-glasses is not usable: ${reason}. Configure it in opencode.json as ["opencode-glasses", { "model": "provider/model-id", "variant": "optional-variant" }] or set ${ENV_MODEL} (and optionally ${ENV_VARIANT}). Pick any model with image attachment support; check with: opencode models <provider> --verbose`
}

function v2AgentHelp() {
  return `opencode-glasses could not run the "${DEFAULT_AGENT}" agent. Define it in opencode.json, e.g.
  "agent": { "vision": { "model": "zai-coding-plan/glm-5.3-flash", "variant": "max", "mode": "all", "prompt": "Answer questions about images tersely and factually." } }
The agent must use a multimodal model; check with: opencode models <provider> --verbose`
}

function extensionForMime(mime: string) {
  return Object.entries(MIME).find(([, m]) => m === mime)?.[0] ?? ".png"
}

/** Most recent image attached in the given session, as a PromptFileAttachment. */
async function latestSessionImage(ctx: V2Context, sessionID: string) {
  const messages = (await ctx.session.context({ sessionID })) as any[]
  let found: any
  for (const message of messages ?? []) {
    for (const file of message.files ?? []) {
      if (String(file.mime ?? "").startsWith("image/")) found = file
    }
  }
  return found
}

/** Materialize a session image attachment as a file:// URI, writing a temp file when needed. */
async function attachmentToUri(attachment: any): Promise<{ uri: string; cleanup?: () => Promise<void> }> {
  if (attachment.source?.type === "uri" && attachment.source.uri) {
    return { uri: attachment.source.uri }
  }
  const dir = await mkdtemp(nodePath.join(tmpdir(), "opencode-glasses-"))
  const file = nodePath.join(dir, `image${extensionForMime(attachment.mime ?? "")}`)
  await writeFile(file, Buffer.from(attachment.data ?? "", "base64"))
  return {
    uri: `file://${file}`,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

// ---------------------------------------------------------------------------
// V2 entrypoint: Plugin.define({ id, setup }) — OpenCode 2.x
// ---------------------------------------------------------------------------

async function setup(ctx: V2Context) {
  const agent = ((ctx.options as Options) ?? {}).agent ?? process.env[ENV_AGENT] ?? DEFAULT_AGENT
  const directory = ctx.location.directory
  debugLog(`v2 setup: agent=${agent} directory=${directory}`)

  await ctx.tool.transform((editor) => {
    editor.add({
      name: "view_image",
      description: TOOL_DESCRIPTION,
      input: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question to answer about the image, e.g. 'transcribe all visible text' or 'describe the error state of this UI'",
          },
          path: {
            type: "string",
            description:
              "Optional path to an image file. Defaults to the most recent image attached in this session.",
          },
        },
        required: ["question"],
        additionalProperties: false,
      },
      async execute(input, context) {
        const args = input as { question: string; path?: string }
        debugLog(`view_image: question=${JSON.stringify(args.question)} path=${JSON.stringify(args.path)}`)

        if (context.agent === agent) {
          return {
            content:
              "You are the vision agent: answer the question directly from the image attached to this conversation. Do not call view_image again.",
          }
        }

        let uri: string | undefined
        let cleanup: (() => Promise<void>) | undefined
        if (args.path) {
          uri = `file://${nodePath.resolve(directory, args.path)}`
        } else {
          const attachment = await latestSessionImage(ctx, context.sessionID)
          if (!attachment) {
            return {
              content:
                "No image found in this session and no path was given. Ask the user to attach the image, or pass an explicit path.",
            }
          }
          const materialized = await attachmentToUri(attachment)
          uri = materialized.uri
          cleanup = materialized.cleanup
        }

        const created = await ctx.session.create({ title: `vision: ${args.question.slice(0, 60)}`, agent })
        const sessionID = created?.id
        if (!sessionID) {
          await cleanup?.()
          return { content: "Failed to create the vision session." }
        }
        debugLog(`vision session ${sessionID} on agent ${agent}`)

        try {
          if (context.signal.aborted) return { content: "Aborted before the vision model answered." }

          await ctx.session.prompt({ sessionID, text: args.question, files: [{ uri: uri! }] })
          await Promise.race([
            ctx.session.wait({ sessionID }),
            sleep(TIMEOUT_MS).then(() => {
              throw new Error("The vision model timed out.")
            }),
          ])

          const messages = (await ctx.session.context({ sessionID })) as any[]
          for (let i = messages.length - 1; i >= 0; i--) {
            const message = messages[i]
            if (message.type !== "assistant") continue
            if (message.error) {
              const detail = message.error.message ?? JSON.stringify(message.error)
              return { content: `Vision model error: ${detail}` }
            }
            const text = (message.content ?? [])
              .filter((part: any) => part.type === "text")
              .map((part: any) => part.text)
              .join("\n")
              .trim()
            if (text) return { content: text }
          }
          return { content: "(the vision model returned no text)" }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (/agent/i.test(message) && /not|unknown|missing/i.test(message)) {
            return { content: v2AgentHelp() }
          }
          throw error
        } finally {
          await ctx.session.remove({ sessionID }).catch(() => {})
          await cleanup?.()
        }
      },
    })
  })
}

// ---------------------------------------------------------------------------
// V1 entrypoint: legacy factory — OpenCode 1.x (>= 1.18.29 reads object default exports)
// ---------------------------------------------------------------------------

async function filePartToDataUrl(url: string, directory: string): Promise<{ url: string; mime: string } | undefined> {
  if (url.startsWith("data:")) {
    const semi = url.indexOf(";")
    const mime = semi > 5 ? url.slice(5, semi) : "image/png"
    return { url, mime }
  }
  let p = url.startsWith("file://") ? url.slice("file://".length) : url
  if (!nodePath.isAbsolute(p)) p = nodePath.resolve(directory, p)
  try {
    const buf = await readFile(p)
    const mime = MIME[nodePath.extname(p).toLowerCase()] ?? "image/png"
    return { url: `data:${mime};base64,${buf.toString("base64")}`, mime }
  } catch {
    return undefined
  }
}

async function latestSessionImageV1(client: any, sessionID: string): Promise<any | undefined> {
  const res = await client.session.messages({ path: { id: sessionID } })
  const messages = res.data ?? []
  let found: any
  for (const m of messages) {
    for (const part of m.parts ?? []) {
      if (part.type === "file" && String(part.mime ?? "").startsWith("image/")) found = part
    }
  }
  return found
}

function resolveV1Config(options: V1Options | undefined) {
  const model = options?.model ?? process.env[ENV_MODEL]
  const variant = options?.variant ?? process.env[ENV_VARIANT]
  const agent = options?.agent ?? process.env[ENV_AGENT] ?? DEFAULT_AGENT
  const parsed = model?.includes("/")
    ? { providerID: model.slice(0, model.indexOf("/")), modelID: model.slice(model.indexOf("/") + 1) }
    : undefined
  return { model, variant, agent, parsed }
}

const server: V1Plugin = async ({ client, directory }, options) => {
  const cfg = resolveV1Config(options as V1Options)

  return {
    config: async (input: any) => {
      debugLog(`v1 config hook: parsed=${JSON.stringify(cfg.parsed)} existingAgents=${JSON.stringify(Object.keys(input.agent ?? {}))}`)
      if (!cfg.parsed) return
      if (!cfg.parsed.modelID || !cfg.parsed.providerID) return
      input.agent ??= {}
      if (input.agent[cfg.agent]) {
        debugLog(`agent "${cfg.agent}" already defined, skipping injection`)
        return
      }
      input.agent[cfg.agent] = {
        description: AGENT_DESCRIPTION,
        mode: "all",
        model: cfg.model,
        ...(cfg.variant ? { variant: cfg.variant } : {}),
        prompt: AGENT_PROMPT,
      } as any
      debugLog(`injected agent "${cfg.agent}" with model ${cfg.model}`)
    },
    tool: {
      view_image: tool({
        description: TOOL_DESCRIPTION,
        args: {
          question: tool.schema
            .string()
            .describe(
              "The question to answer about the image, e.g. 'transcribe all visible text' or 'describe the error state of this UI'",
            ),
          path: tool.schema
            .string()
            .optional()
            .describe(
              "Optional path to an image file. Defaults to the most recent image attached in this session.",
            ),
        },
        async execute(args: { question: string; path?: string }, context: any) {
          if (!cfg.parsed) {
            return v1ConfigHelp(
              cfg.model ? `model "${cfg.model}" is not in provider/model-id form` : "no vision model configured",
            )
          }

          let source: { url: string; mime: string } | undefined
          if (args.path) {
            const p = nodePath.resolve(context.directory, args.path)
            const buf = await readFile(p)
            const mime = MIME[nodePath.extname(p).toLowerCase()] ?? "image/png"
            source = { url: `data:${mime};base64,${buf.toString("base64")}`, mime }
          } else {
            const part = await latestSessionImageV1(client, context.sessionID)
            if (!part) {
              return "No image found in this session and no path was given. Ask the user to attach the image, or pass an explicit path."
            }
            source = await filePartToDataUrl(part.url, context.directory)
            if (!source) return `Could not read the image at ${part.url}`
          }

          const created = await client.session.create({
            body: { title: `vision: ${args.question.slice(0, 60)}` },
          })
          const sessionID = created.data?.id
          if (!sessionID) return "Failed to create the vision session."

          try {
            const prompted = await client.session.prompt({
              path: { id: sessionID },
              body: {
                agent: cfg.agent,
                tools: {
                  view_image: false,
                  bash: false,
                  edit: false,
                  read: false,
                  glob: false,
                  grep: false,
                  list: false,
                  task: false,
                  webfetch: false,
                  websearch: false,
                  lsp: false,
                  todowrite: false,
                },
                parts: [
                  { type: "text", text: args.question },
                  { type: "file", url: source.url, mime: source.mime, filename: "image" },
                ],
              },
            })
            const messageID = prompted.data?.info?.id
            if (!messageID) {
              return `The vision session failed to start. Check that the "${cfg.agent}" agent exists with a valid multimodal model.`
            }

            const deadline = Date.now() + TIMEOUT_MS
            while (Date.now() < deadline) {
              if (context.abort.aborted) return "Aborted before the vision model answered."
              await sleep(500)
              const msg = await client.session.message({ path: { id: sessionID, messageID } })
              const info: any = msg.data?.info
              if (info?.error) return `Vision model error: ${JSON.stringify(info.error)}`
              if (info?.time?.completed) {
                const text = (msg.data?.parts ?? [])
                  .filter((p: any) => p.type === "text")
                  .map((p: any) => p.text)
                  .join("\n")
                  .trim()
                return text || "(the vision model returned no text)"
              }
            }
            return "The vision model timed out."
          } finally {
            await client.session.delete({ path: { id: sessionID } }).catch(() => {})
          }
        },
      }),
    },
  }
}

// ---------------------------------------------------------------------------
// Dual entrypoint: V2 reads { id, setup }, V1 (>= 1.18.29) reads server().
// ---------------------------------------------------------------------------

export default {
  ...Plugin.define({
    id: "opencode-glasses",
    setup,
  }),
  server,
}
