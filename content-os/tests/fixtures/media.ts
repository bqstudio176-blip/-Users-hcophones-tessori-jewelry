import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Generates deterministic fixture videos with ffmpeg (no binary fixtures in git).
 * three-scenes.mp4: red 0–2s, blue 2–4s, green 4–6s, 440 Hz tone → 2 real cuts.
 */
export function makeThreeSceneVideo(dir: string, opts: { audio?: boolean; name?: string } = {}): string {
  const out = path.join(dir, opts.name ?? (opts.audio === false ? "three-scenes-silent.mp4" : "three-scenes.mp4"));
  const video = ["-f", "lavfi", "-i", "color=c=red:s=320x240:d=2:r=25", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=2:r=25", "-f", "lavfi", "-i", "color=c=green:s=320x240:d=2:r=25"];
  const audio = opts.audio === false ? [] : ["-f", "lavfi", "-i", "sine=frequency=440:duration=6"];
  const filter = ["-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1:a=0[v]", "-map", "[v]"];
  const audioMap = opts.audio === false ? [] : ["-map", "3:a", "-c:a", "aac", "-b:a", "64k"];
  execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", ...video, ...audio, ...filter, ...audioMap, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-t", "6", out]);
  return out;
}

/** A shell script renamed to .mp4 — must be rejected, never executed. */
export function makeFakeVideo(dir: string): string {
  const out = path.join(dir, "not-a-video.mp4");
  writeFileSync(out, "#!/bin/sh\necho pwned > /tmp/pwned\n");
  return out;
}
