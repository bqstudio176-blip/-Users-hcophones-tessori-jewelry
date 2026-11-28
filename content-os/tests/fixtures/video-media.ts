import { execFileSync } from "node:child_process";
import path from "node:path";

/** Deterministic fixture media for Video Studio tests (generated with ffmpeg, nothing binary in git). */
const ff = (args: string[]) => execFileSync("ffmpeg", ["-nostdin", "-y", "-v", "error", ...args]);

export function makeClip(dir: string, name = "clip.mp4", opts: { seconds?: number; color?: string; size?: string; audio?: boolean } = {}): string {
  const out = path.join(dir, name);
  const d = String(opts.seconds ?? 4);
  const audio = opts.audio === false ? [] : ["-f", "lavfi", "-i", `sine=frequency=330:duration=${d}`];
  ff(["-f", "lavfi", "-i", `testsrc2=s=${opts.size ?? "640x360"}:d=${d}:r=25`, ...audio, "-c:v", "libx264", "-pix_fmt", "yuv420p", ...(opts.audio === false ? [] : ["-c:a", "aac", "-b:a", "64k"]), "-t", d, out]);
  return out;
}

export function makeImage(dir: string, name = "still.png", size = "800x600"): string {
  const out = path.join(dir, name);
  ff(["-f", "lavfi", "-i", `color=c=orange:s=${size}:d=1`, "-frames:v", "1", out]);
  return out;
}

/** A tone with silence in the middle — stands in for a spoken voiceover. */
export function makeVoice(dir: string, name = "voice.m4a", seconds = 6): string {
  const out = path.join(dir, name);
  ff(["-f", "lavfi", "-i", `sine=frequency=220:duration=${seconds}`, "-af", "volume=0.6", "-c:a", "aac", "-b:a", "96k", out]);
  return out;
}

export function makeMusic(dir: string, name = "music.mp3", seconds = 3): string {
  const out = path.join(dir, name);
  ff(["-f", "lavfi", "-i", `sine=frequency=523:duration=${seconds}`, "-c:a", "libmp3lame", "-b:a", "128k", out]);
  return out;
}
