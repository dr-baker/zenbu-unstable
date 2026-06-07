import { createSchema, collection, z } from "@zenbujs/core/db"

// Registry listing, cached in `catalog` (keyed by id) on fetch so
// reopening a plugin is instant and the network call just revalidates.
const listing = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.string().nullable(),
  author: z.string(),
  tags: z.array(z.string()),
  downloadCount: z.number(),
  reviewStatus: z.string(),
  minHostVersion: z.string().nullable(),
  updatedAt: z.string(),
  readme: z.string().nullable().default(null),
})

export default createSchema({
  enabled: z.boolean().default(false),
  // Per-id cache (detail view, install metadata).
  catalog: z.record(z.string(), listing).default({}),
  // The browse list, lazily loaded + cached locally. A background
  // service refreshes it every few minutes (rotate-and-swap), so
  // navigating away and back reads from the cache instantly instead
  // of refetching.
  feed: collection(listing, { debugName: "marketplace-feed" }),
})
