import type { SVGProps } from "react";

/** Minimal inline stroke icon set (24px grid, currentColor). */
type IconProps = SVGProps<SVGSVGElement>;
const S = ({ children, ...props }: IconProps & { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" width={18} height={18} aria-hidden {...props}>
    {children}
  </svg>
);

export const Icons = {
  overview: (p: IconProps) => <S {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></S>,
  discover: (p: IconProps) => <S {...p}><circle cx="12" cy="12" r="9" /><path d="m15.5 8.5-2 5-5 2 2-5z" /></S>,
  analyze: (p: IconProps) => <S {...p}><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 5-6" /></S>,
  scriptLab: (p: IconProps) => <S {...p}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></S>,
  videoStudio: (p: IconProps) => <S {...p}><rect x="3" y="5" width="13" height="14" rx="2" /><path d="m16 10 5-3v10l-5-3" /></S>,
  experiments: (p: IconProps) => <S {...p}><path d="M9 3h6M10 3v6L4.5 18.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3" /><path d="M7.5 15h9" /></S>,
  publish: (p: IconProps) => <S {...p}><path d="m22 2-7 20-4-9-9-4z" /><path d="M22 2 11 13" /></S>,
  analytics: (p: IconProps) => <S {...p}><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></S>,
  settings: (p: IconProps) => <S {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></S>,
  shield: (p: IconProps) => <S {...p}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></S>,
  instagram: (p: IconProps) => <S {...p}><rect x="3" y="3" width="18" height="18" rx="5" /><circle cx="12" cy="12" r="4" /><circle cx="17.5" cy="6.5" r=".6" fill="currentColor" /></S>,
  logout: (p: IconProps) => <S {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" /></S>,
  menu: (p: IconProps) => <S {...p}><path d="M4 6h16M4 12h16M4 18h16" /></S>,
  close: (p: IconProps) => <S {...p}><path d="M18 6 6 18M6 6l12 12" /></S>,
  check: (p: IconProps) => <S {...p}><path d="M20 6 9 17l-5-5" /></S>,
  plus: (p: IconProps) => <S {...p}><path d="M12 5v14M5 12h14" /></S>,
  chevronDown: (p: IconProps) => <S {...p}><path d="m6 9 6 6 6-6" /></S>,
  sparkles: (p: IconProps) => <S {...p}><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" /><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" /></S>,
  users: (p: IconProps) => <S {...p}><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8" /></S>,
  coins: (p: IconProps) => <S {...p}><circle cx="8" cy="8" r="6" /><path d="M18.1 10.4A6 6 0 1 1 10.3 18" /><path d="M7 6h1v4" /></S>,
};
export type IconName = keyof typeof Icons;
