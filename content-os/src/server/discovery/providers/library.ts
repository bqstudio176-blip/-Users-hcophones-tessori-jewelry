import type { DiscoveryProvider } from "../types";

export const libraryProvider: DiscoveryProvider = {
  id: "library",
  name: "Reference library",
  supportsSearch: true,
  supportsTrending: false,
  docs: {
    capabilities: ["Keyword search across title, description, author and notes", "Category and format filters"],
    authentication: "None — uses the signed-in member's access to this workspace (RLS).",
    rateLimits: "None beyond database limits.",
    metadata: ["Title", "Description", "Author", "Thumbnail", "Duration", "Category", "Analysis status"],
    restrictions: "Only references saved in the current workspace.",
    costs: "Free.",
    docsUrl: null,
  },
  async availability() {
    return { available: true };
  },
  async search(q, ctx) {
    if (!ctx.searchLibrary) return [];
    return ctx.searchLibrary(q);
  },
};
