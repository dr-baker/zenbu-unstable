import { describe, expect, it } from "vitest"

import {
  applyActivationStates,
  deriveSessionStaleness,
  hashJson,
  resourceId,
  selectPreloadScopeIds,
  tierFromSourceInfo,
  type ResourceObservation,
  type SourceInfoShape,
} from "./pi-resource-registry-helpers"

function observation(args: {
  resourceType: ResourceObservation["resourceType"]
  canonicalPath: string
  resourceId?: string
  tier?: ResourceObservation["tier"]
}): ResourceObservation {
  const sourceInfo: SourceInfoShape = {
    path: args.canonicalPath,
    source: "auto",
    scope: "project",
    origin: "top-level",
  }
  return {
    resourceId: args.resourceId ?? resourceId(args.resourceType, args.canonicalPath),
    resourceType: args.resourceType,
    canonicalPath: args.canonicalPath,
    label: null,
    tier: args.tier ?? "pi-project",
    sourceInfo,
  }
}

describe("applyActivationStates", () => {
  it("marks the first enabled duplicate active and later ones suppressed", () => {
    const path = "/tmp/skill-a/SKILL.md"
    const first = observation({ resourceType: "skill", canonicalPath: path, resourceId: "a" })
    const second = observation({ resourceType: "skill", canonicalPath: path, resourceId: "b" })
    const entries = applyActivationStates([
      { observation: first, enabled: true, order: 0, missing: false },
      { observation: second, enabled: true, order: 1, missing: false },
    ])
    expect(entries[0]?.activationState).toBe("active")
    expect(entries[1]?.activationState).toBe("suppressed")
    expect(entries[1]?.suppressedByResourceId).toBe("a")
  })

  it("marks missing and disabled entries separately", () => {
    const entries = applyActivationStates([
      {
        observation: observation({
          resourceType: "extension",
          canonicalPath: "/tmp/missing.ts",
        }),
        enabled: true,
        order: 0,
        missing: true,
      },
      {
        observation: observation({
          resourceType: "prompt",
          canonicalPath: "/tmp/disabled.md",
        }),
        enabled: false,
        order: 1,
        missing: false,
      },
    ])
    expect(entries.map(entry => entry.activationState)).toEqual(["missing", "disabled"])
  })
})

describe("deriveSessionStaleness", () => {
  it("is stale when activation hashes differ", () => {
    expect(
      deriveSessionStaleness({
        activationHashAtLoad: "abc",
        currentActivationHash: "def",
      }),
    ).toEqual({ stale: true, reason: "static catalog activation changed" })
  })

  it("is fresh when hashes match or are absent", () => {
    expect(
      deriveSessionStaleness({
        activationHashAtLoad: "abc",
        currentActivationHash: "abc",
      }),
    ).toEqual({ stale: false, reason: null })
    expect(
      deriveSessionStaleness({
        activationHashAtLoad: null,
        currentActivationHash: "abc",
      }),
    ).toEqual({ stale: false, reason: null })
  })
})

describe("hashJson", () => {
  it("sorts object keys for stable hashes", () => {
    expect(hashJson({ b: 2, a: 1 })).toBe(hashJson({ a: 1, b: 2 }))
  })
})

describe("resourceId", () => {
  it("is stable for the same canonical path and type", () => {
    const path = "/tmp/ext/foo.ts"
    expect(resourceId("extension", path)).toBe(resourceId("extension", path))
    expect(resourceId("extension", path)).not.toBe(resourceId("skill", path))
  })
})

describe("tierFromSourceInfo", () => {
  it("maps zenbu and pi scopes", () => {
    expect(
      tierFromSourceInfo({
        path: "/x",
        source: "built-in",
        scope: "temporary",
        origin: "top-level",
      }),
    ).toBe("zenbu-built-in")
    expect(
      tierFromSourceInfo({
        path: "/x",
        source: "npm:foo",
        scope: "user",
        origin: "package",
      }),
    ).toBe("pi-package")
  })
})

describe("selectPreloadScopeIds", () => {
  it("prioritizes focused scopes before pinned recents", () => {
    const ids = selectPreloadScopeIds({
      max: 2,
      windowStates: [{ selectedScopeId: "focused" }],
      scopes: [
        {
          id: "focused",
          archived: false,
          pinnedAt: null,
          createdAt: 1,
        },
        {
          id: "pinned",
          archived: false,
          pinnedAt: 100,
          createdAt: 50,
        },
        {
          id: "old",
          archived: false,
          pinnedAt: null,
          createdAt: 200,
        },
      ],
    })
    expect(ids).toEqual(["focused", "pinned"])
  })
})
