import { describe, expect, it } from "vitest"
import { authProjectionMatches } from "./auth-projection"

describe("authProjectionMatches", () => {
  it("recognizes unchanged provider/model projections despite object key order", () => {
    expect(
      authProjectionMatches({
        currentProviderStatuses: {
          openai: {
            id: "openai",
            configured: true,
            nested: { b: 2, a: 1 },
          },
        },
        nextProviderStatuses: {
          openai: {
            nested: { a: 1, b: 2 },
            configured: true,
            id: "openai",
          },
        },
        currentModels: {
          "openai/gpt": { input: ["text"], maxTokens: 8192 },
        },
        nextModels: {
          "openai/gpt": { maxTokens: 8192, input: ["text"] },
        },
      }),
    ).toBe(true)
  })

  it("detects provider or model changes", () => {
    const current = {
      currentProviderStatuses: { openai: { configured: false } },
      nextProviderStatuses: { openai: { configured: true } },
      currentModels: { "openai/gpt": { maxTokens: 8192 } },
      nextModels: { "openai/gpt": { maxTokens: 8192 } },
    }
    expect(authProjectionMatches(current)).toBe(false)

    expect(
      authProjectionMatches({
        currentProviderStatuses: { openai: { configured: true } },
        nextProviderStatuses: { openai: { configured: true } },
        currentModels: { "openai/gpt": { maxTokens: 8192 } },
        nextModels: { "openai/gpt": { maxTokens: 4096 } },
      }),
    ).toBe(false)
  })
})
