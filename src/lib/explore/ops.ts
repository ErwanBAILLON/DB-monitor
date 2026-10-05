// Operation names of the explorer HTTP API (kept dependency-free for the client and tests).
export const EXPLORE_OPS = ["containers", "objects", "describe", "browse", "profile", "stats"] as const;
export type ExploreOp = (typeof EXPLORE_OPS)[number];
