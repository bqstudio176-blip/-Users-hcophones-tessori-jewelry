import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import type { ReactNode } from "react";
import { THEME_COOKIE } from "@/lib/auth/session";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: { default: "Content OS", template: "%s · Content OS" },
  description: "The operating system for short-form content teams.",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0a0a0d",
  colorScheme: "dark light",
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const theme = (await cookies()).get(THEME_COOKIE)?.value;
  // dark (default) | light → explicit attribute; system → omit and follow the OS.
  const dataTheme = theme === "light" ? "light" : theme === "system" ? undefined : "dark";
  return (
    <html lang="en" data-theme={dataTheme} suppressHydrationWarning>
      <body>
        <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[100] focus:rounded-md focus:bg-accent focus:px-4 focus:py-2 focus:text-accent-fg">
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
