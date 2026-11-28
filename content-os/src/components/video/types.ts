import type { Word } from "@/server/video/timeline";

/** Asset data the editor needs (signed URLs are short-lived and minted per request). */
export interface EditorAsset {
  id: string;
  kind: "video" | "image" | "audio";
  title: string;
  status: string;
  duration: number | null;
  hasAudio: boolean | null;
  thumbUrl: string | null;
  proxyUrl: string | null;
}

export interface EditorTake {
  id: string;
  sceneKey: string | null;
  status: string;
  assetId: string;
  words: Word[];
  similarity: number | null;
  createdAt: string;
}
