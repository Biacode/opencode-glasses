import { readFile } from "node:fs/promises"
import nodePath from "node:path"
import { tool, type Plugin } from "@opencode-ai/plugin"

type Options = {
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
const POLL_MS = 500

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

function resolveConfig(options: Options | undefined) {
  const model = options?.model ?? process.env[ENV_MODEL]
  const variant = options?.variant ?? process.env[ENV_VARIANT]
  const agent = options?.agent ?? process.env[ENV_AGENT] ?? DEFAULT_AGENT
  const parsed = model?.includes("/")
    ? { providerID: model.slice(0, model.indexOf("/")), modelID: model.slice(model.indexOf("/") + 1) }
    : undefined
  return { model, variant, agent, parsed }
}

function configHelp(reason: string) {
  return `opencode-glasses is not usable: ${reason}. Configure it in opencode.json as ["opencode-glasses", { "model": "provider/model-id", "variant": "optional-variant" }] or set ${ENV_MODEL} (and optionally ${ENV_VARIANT}). Pick any model with image attachment support; check with: opencode models <provider> --verbose`
}

async function filePartToDataUrl(
  url: string,
  directory: string,
): Promise<{ url: string; mime: string } | undefined> {
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

async function latestSessionImage(client: any, sessionID: string): Promise<any | undefined> {
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

export default (async ({ client, directory }, options) => {
  const cfg = resolveConfig(options)
  const debug = process.env.OPENCODE_GLASSES_DEBUG === "1"
  const log = (m: string) => {
    if (debug) console.error(`[opencode-glasses] ${m}`)
  }
  log(`options=${JSON.stringify(options)} resolved=${JSON.stringify(cfg)}`)

  return {
    config: async (input) => {
      log(`config hook: parsed=${JSON.stringify(cfg.parsed)} existingAgents=${JSON.stringify(Object.keys(input.agent ?? {}))}`)
      if (!cfg.parsed) return
      if (!cfg.parsed.modelID || !cfg.parsed.providerID) return
      input.agent ??= {}
      if (input.agent[cfg.agent]) {
        log(`agent "${cfg.agent}" already defined, skipping injection`)
        return
      }
      input.agent[cfg.agent] = {
        description: AGENT_DESCRIPTION,
        mode: "all",
        model: cfg.model,
        ...(cfg.variant ? { variant: cfg.variant } : {}),
        prompt: AGENT_PROMPT,
      } as any
      log(`injected agent "${cfg.agent}" with model ${cfg.model}`)
    },
    tool: {
      view_image: tool({
        description:
          "Inspect an image using the multimodal vision model. The current coding model cannot see images. Use this tool EVERY time a message includes a pasted or attached image (screenshot, photo, diagram, chart, UI capture) and the answer requires seeing its content: reading text inside it, describing layout, colors, or visual state. This includes messages where an image part was replaced by a notice or error saying the model does not support image input: that notice means an image IS attached and this tool can still inspect it. You may call this tool repeatedly, e.g. to ask follow-up questions about the same image. NEVER tell the user to save an image to a file or provide a path; the session's images are directly accessible to this tool. Returns the vision model's textual answer. Optionally pass a file path; without one, the most recent image in this session is inspected.",
        args: {
          question: tool.schema
            .string()
            .describe("The question to answer about the image, e.g. 'transcribe all visible text' or 'describe the error state of this UI'"),
          path: tool.schema
            .string()
            .optional()
            .describe("Optional path to an image file. Defaults to the most recent image attached in this session."),
        },
        async execute(args, context) {
          if (!cfg.parsed) {
            return configHelp(cfg.model ? `model "${cfg.model}" is not in provider/model-id form` : "no vision model configured")
          }

          let source: { url: string; mime: string } | undefined
          if (args.path) {
            const p = nodePath.resolve(context.directory, args.path)
            const buf = await readFile(p)
            const mime = MIME[nodePath.extname(p).toLowerCase()] ?? "image/png"
            source = { url: `data:${mime};base64,${buf.toString("base64")}`, mime }
          } else {
            const part = await latestSessionImage(client, context.sessionID)
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
              await sleep(POLL_MS)
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
}) satisfies Plugin
