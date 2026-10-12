import { describe, expect, test } from "bun:test"
import definition from "./index"

const plugin = definition as any

// ---------------------------------------------------------------------------
// V2 surface: default export is Plugin.define({ id, setup }) plus a V1 server()
// ---------------------------------------------------------------------------

describe("v2 definition", () => {
  test("default-exports a definition with id, setup, and v1 server", () => {
    expect(plugin.id).toBe("opencode-glasses")
    expect(typeof plugin.setup).toBe("function")
    expect(typeof plugin.server).toBe("function")
  })
})

function makeCtx(overrides: Record<string, unknown> = {}) {
  const added: any[] = []
  const calls: Record<string, any[]> = { create: [], prompt: [], wait: [], remove: [], context: [] }
  const answerText = "a cat sitting on a keyboard"
  const ctx = {
    location: { directory: "/tmp/project" },
    options: {},
    tool: {
      transform: async (cb: any) => cb({ add: (t: any) => added.push(t) }),
    },
    session: {
      create: async (input: any) => {
        calls.create.push(input)
        return { id: "vision_sess" }
      },
      prompt: async (input: any) => {
        calls.prompt.push(input)
        return {}
      },
      wait: async (input: any) => {
        calls.wait.push(input)
      },
      context: async (input: any) => {
        calls.context.push(input)
        return [
          {
            type: "user",
            id: "msg_user",
            text: "what is in this image?",
            files: [
              {
                data: Buffer.from("fake-png").toString("base64"),
                mime: "image/png",
                source: { type: "inline" },
              },
            ],
          },
          {
            type: "assistant",
            id: "msg_assistant",
            time: { completed: 1 },
            content: [{ type: "text", text: answerText }],
          },
        ]
      },
      remove: async (input: any) => {
        calls.remove.push(input)
      },
    },
    ...overrides,
  }
  return { ctx, added, calls, answerText }
}

describe("v2 setup", () => {
  test("registers the view_image tool with a JSON schema", async () => {
    const { ctx, added } = makeCtx()
    await plugin.setup(ctx)

    expect(added.map((t) => t.name)).toEqual(["view_image"])
    const tool = added[0]
    expect(tool.description).toContain("Inspect an image")
    expect(tool.input.type).toBe("object")
    expect(tool.input.properties.question.type).toBe("string")
    expect(tool.input.properties.path.type).toBe("string")
    expect(tool.input.required).toEqual(["question"])
    expect(typeof tool.execute).toBe("function")
  })

  test("delegates to a throwaway session on the configured agent and cleans up", async () => {
    const { ctx, added, calls, answerText } = makeCtx()
    ctx.options = { agent: "looker" }
    await plugin.setup(ctx)

    const result = await added[0].execute(
      { question: "what is in this image?" },
      { sessionID: "sess_main", signal: new AbortController().signal },
    )

    expect(result.content).toContain(answerText)
    expect(calls.create[0].agent).toBe("looker")
    expect(calls.prompt[0].sessionID).toBe("vision_sess")
    expect(calls.prompt[0].text).toBe("what is in this image?")
    expect(calls.prompt[0].files.length).toBe(1)
    expect(calls.prompt[0].files[0].uri.startsWith("file://")).toBe(true)
    expect(calls.remove[0].sessionID).toBe("vision_sess")
  })

  test("refuses to recurse when called from the vision agent itself", async () => {
    const { ctx, added, calls } = makeCtx()
    await plugin.setup(ctx)
    const result = await added[0].execute(
      { question: "what is in this image?" },
      { sessionID: "s", agent: "vision", signal: new AbortController().signal },
    )
    expect(result.content).toContain("vision agent")
    expect(result.content).toContain("directly")
    expect(calls.create.length).toBe(0)
  })

  test("defaults the agent name to vision", async () => {
    const { ctx, added, calls } = makeCtx()
    await plugin.setup(ctx)
    await added[0].execute({ question: "hi" }, { sessionID: "s", signal: new AbortController().signal })
    expect(calls.create[0].agent).toBe("vision")
  })

  test("honors the OPENCODE_GLASSES_AGENT env var", async () => {
    process.env.OPENCODE_GLASSES_AGENT = "peeker"
    try {
      const { ctx, added, calls } = makeCtx()
      await plugin.setup(ctx)
      await added[0].execute({ question: "hi" }, { sessionID: "s", signal: new AbortController().signal })
      expect(calls.create[0].agent).toBe("peeker")
    } finally {
      delete process.env.OPENCODE_GLASSES_AGENT
    }
  })

  test("returns a helpful message when no image is in the session and no path given", async () => {
    const { ctx, added, calls } = makeCtx({
      session: {
        context: async () => [{ type: "user", id: "u", text: "no image here" }],
      },
    })
    await plugin.setup(ctx)
    const result = await added[0].execute(
      { question: "what is this?" },
      { sessionID: "s", signal: new AbortController().signal },
    )
    expect(result.content).toContain("No image found")
    expect(calls.create.length).toBe(0)
  })

  test("surfaces a vision model error and still removes the session", async () => {
    const { ctx, added, calls } = makeCtx({
      session: {
        create: async () => ({ id: "vision_sess" }),
        prompt: async () => ({}),
        wait: async () => {},
        context: async () => [
          { type: "user", id: "u", text: "q", files: [{ data: "AAAA", mime: "image/png", source: { type: "inline" } }] },
          { type: "assistant", id: "a", time: {}, error: { message: "model exploded" } },
        ],
        remove: async (input: any) => {
          calls.remove.push(input)
        },
      },
    })
    await plugin.setup(ctx)
    const result = await added[0].execute(
      { question: "what?" },
      { sessionID: "s", signal: new AbortController().signal },
    )
    expect(result.content).toContain("model exploded")
    expect(calls.remove[0].sessionID).toBe("vision_sess")
  })

  test("cleans up the session when the vision call throws", async () => {
    const { ctx, added, calls } = makeCtx({
      session: {
        create: async () => ({ id: "vision_sess" }),
        prompt: async () => {
          throw new Error("boom")
        },
        wait: async () => {},
        context: async () => [
          { type: "user", id: "u", text: "q", files: [{ data: "AAAA", mime: "image/png", source: { type: "inline" } }] },
        ],
        remove: async (input: any) => {
          calls.remove.push(input)
        },
      },
    })
    await plugin.setup(ctx)
    await expect(
      added[0].execute({ question: "q" }, { sessionID: "s", signal: new AbortController().signal }),
    ).rejects.toThrow("boom")
    expect(calls.remove[0].sessionID).toBe("vision_sess")
  })
})

// ---------------------------------------------------------------------------
// V1 surface: server() keeps the legacy factory for OpenCode 1 (>= 1.18.29)
// ---------------------------------------------------------------------------

async function loadV1(options?: any) {
  const hooks = await plugin.server({ client: {} }, options)
  return hooks
}

describe("v1 config hook", () => {
  test("injects the vision agent when a model is configured", async () => {
    const hooks = await loadV1({ model: "zai-coding-plan/glm-5.3-flash", variant: "max" })
    const cfg: any = { agent: {} }
    await hooks.config!(cfg)
    expect(cfg.agent.vision).toBeDefined()
    expect(cfg.agent.vision.model).toBe("zai-coding-plan/glm-5.3-flash")
    expect(cfg.agent.vision.variant).toBe("max")
    expect(cfg.agent.vision.mode).toBe("all")
    expect(cfg.agent.vision.prompt).toContain("vision specialist")
  })

  test("does not clobber an existing agent of the same name", async () => {
    const hooks = await loadV1({ model: "zai-coding-plan/glm-5.3-flash" })
    const cfg: any = { agent: { vision: { model: "custom/model", mode: "subagent" } } }
    await hooks.config!(cfg)
    expect(cfg.agent.vision.model).toBe("custom/model")
  })

  test("injects nothing when no model is configured", async () => {
    const hooks = await loadV1()
    const cfg: any = {}
    await hooks.config!(cfg)
    expect(cfg.agent).toBeUndefined()
  })

  test("injects nothing when the model is not in provider/model form", async () => {
    const hooks = await loadV1({ model: "glm-5.3-flash" })
    const cfg: any = {}
    await hooks.config!(cfg)
    expect(cfg.agent).toBeUndefined()
  })

  test("honors a custom agent name", async () => {
    const hooks = await loadV1({ model: "groq/llama-4-scout", agent: "looker" })
    const cfg: any = { agent: {} }
    await hooks.config!(cfg)
    expect(cfg.agent.looker).toBeDefined()
    expect(cfg.agent.vision).toBeUndefined()
  })
})

describe("v1 view_image tool", () => {
  test("is registered with a description", async () => {
    const hooks = await loadV1({ model: "zai-coding-plan/glm-5.3-flash" })
    expect(hooks.tool.view_image).toBeDefined()
    expect(hooks.tool.view_image.description).toContain("Inspect an image")
  })

  test("returns configuration help when no model is configured", async () => {
    const hooks = await loadV1()
    const out = await hooks.tool.view_image.execute(
      { question: "what is this?" },
      { sessionID: "s", directory: "/tmp", abort: new AbortController().signal },
    )
    expect(String(out)).toContain("opencode-glasses is not usable")
  })
})
