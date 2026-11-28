import type { ReactNode } from "react";
import { VideoStudioNav } from "@/components/video/video-studio-nav";

export default function VideoStudioLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <VideoStudioNav />
      {children}
    </>
  );
}
