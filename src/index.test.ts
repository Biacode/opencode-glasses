import { describe, expect, test } from "bun:test"
import plugin from "./index"

async function load(options?: any) {
  const hooks = await (plugin as any)({ client: {} }, options)
  return hooks
}

describe("config hook", () => {
  test("injects the vision agent when a model is configured", async () => {
    const hooks = await load({ model: "zai-coding-plan/glm-5.3-flash", variant: "max" })
    const cfg: any = { agent: {} }
    await hooks.config!(cfg)
    expect(cfg.agent.vision).toBeDefined()
    expect(cfg.agent.vision.model).toBe("zai-coding-plan/glm-5.3-flash")
    expect(cfg.agent.vision.variant).toBe("max")
    expect(cfg.agent.vision.mode).toBe("all")
    expect(cfg.agent.vision.prompt).toContain("vision specialist")
  })

  test("does not clobber an existing agent of the same name", async () => {
    const hooks = await load({ model: "zai-coding-plan/glm-5.3-flash" })
    const cfg: any = { agent: { vision: { model: "custom/model", mode: "subagent" } } }
    await hooks.config!(cfg)
    expect(cfg.agent.vision.model).toBe("custom/model")
  })

  test("injects nothing when no model is configured", async () => {
    const hooks = await load()
    const cfg: any = {}
    await hooks.config!(cfg)
    expect(cfg.agent).toBeUndefined()
  })

  test("injects nothing when the model is not in provider/model form", async () => {
    const hooks = await load({ model: "glm-5.3-flash" })
    const cfg: any = {}
    await hooks.config!(cfg)
    expect(cfg.agent).toBeUndefined()
  })

  test("honors a custom agent name", async () => {
    const hooks = await load({ model: "groq/llama-4-scout", agent: "looker" })
    const cfg: any = { agent: {} }
    await hooks.config!(cfg)
    expect(cfg.agent.looker).toBeDefined()
    expect(cfg.agent.vision).toBeUndefined()
  })
})

describe("view_image tool", () => {
  test("is registered with a description", async () => {
    const hooks = await load({ model: "zai-coding-plan/glm-5.3-flash" })
    expect(hooks.tool.view_image).toBeDefined()
    expect(hooks.tool.view_image.description).toContain("Inspect an image")
  })

  test("returns configuration help when no model is configured", async () => {
    const hooks = await load()
    const out = await hooks.tool.view_image.execute(
      { question: "what is this?" },
      { sessionID: "s", messageID: "m", agent: "build", directory: "/tmp", abort: new AbortController().signal, metadata: () => {}, ask: async () => {} },
    )
    expect(out).toContain("opencode-glasses is not usable")
    expect(out).toContain("OPENCODE_GLASSES_MODEL")
  })
})
