import type { Config } from "tailwindcss";

const token = (name: string) => `rgb(var(--color-${name}) / <alpha-value>)`;

export default {
  content: ["./src/**/*.{ts,tsx}"],
  darkMode: ["selector", '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        bg: token("bg"),
        surface: { DEFAULT: token("surface"), 2: token("surface-2"), 3: token("surface-3") },
        line: { DEFAULT: token("border"), strong: token("border-strong") },
        fg: { DEFAULT: token("text"), muted: token("text-muted"), subtle: token("text-subtle") },
        accent: { DEFAULT: token("accent"), hover: token("accent-hover"), fg: token("accent-fg"), soft: token("accent-soft") },
        success: token("success"),
        warning: token("warning"),
        danger: token("danger"),
        info: token("info"),
        ring: token("ring"),
      },
      borderRadius: { sm: "var(--radius-sm)", md: "var(--radius-md)", lg: "var(--radius-lg)" },
      boxShadow: { elevated: "var(--shadow-elevated)" },
      fontFamily: { sans: ["var(--font-sans)"], mono: ["var(--font-mono)"] },
      keyframes: { shimmer: { "100%": { transform: "translateX(100%)" } } },
    },
  },
  plugins: [],
} satisfies Config;
