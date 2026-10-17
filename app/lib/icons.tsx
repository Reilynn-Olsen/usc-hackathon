import type { ReactNode } from "react";

type IconName = "grid" | "flask" | "info" | "ship" | "storm" | "fog" | "wind" | "outage" | "arrow" | "chevron" | "clock" | "shield" | "check" | "reset" | "play" | "sparkle" | "layers" | "route" | "anchor" | "alert" | "close" | "minus" | "plus" | "back" | "settings" | "trend" | "box" | "target" | "pause" | "globe" | "menu" | "github";

export function Icon({ name, size = 18, strokeWidth = 1.8, className = "" }: { name: IconName; size?: number; strokeWidth?: number; className?: string }) {
  const paths: Record<IconName, ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.3"/><rect x="14" y="3" width="7" height="7" rx="1.3"/><rect x="3" y="14" width="7" height="7" rx="1.3"/><rect x="14" y="14" width="7" height="7" rx="1.3"/></>,
    flask: <><path d="M9 3h6M10 3v6l-5.3 8.8A2 2 0 0 0 6.4 21h11.2a2 2 0 0 0 1.7-3.2L14 9V3"/><path d="M8 15h8"/></>,
    info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></>,
    ship: <><path d="M3 17l9 4 9-4-3-9H6l-3 9ZM12 3v5M8 8V5h8v3"/><path d="M7 14h10"/></>,
    storm: <><path d="M5.5 17a4.5 4.5 0 0 1-1-8.9A7 7 0 0 1 18 9a4 4 0 0 1 1 8"/><path d="m12 12-3 5h4l-2 5"/></>,
    fog: <><path d="M4 7h16M2 12h13M7 17h15M4 21h11"/></>,
    wind: <><path d="M3 8h13a3 3 0 1 0-3-3M2 13h18a2.5 2.5 0 1 1-2.5 2.5M5 18h7a2.5 2.5 0 1 1-2.5 2.5"/></>,
    outage: <><path d="M14 2v6l3 2-4 5-4-4 2-3V2M7 13l-3 4 4 5 5-5"/><path d="M17 16h5M19.5 13.5v5"/></>,
    arrow: <><path d="M4 12h16m-7-7 7 7-7 7"/></>,
    chevron: <path d="m9 6 6 6-6 6"/>,
    clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
    shield: <><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/><path d="m9 12 2 2 4-4"/></>,
    check: <path d="m5 12 4 4L19 6"/>,
    reset: <><path d="M3 11a9 9 0 1 1 2.6 6.4M3 5v6h6"/></>,
    play: <path d="m8 5 11 7-11 7V5Z"/>,
    sparkle: <><path d="m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8L12 2ZM19 17l.6 1.4L21 19l-1.4.6L19 21l-.6-1.4L17 19l1.4-.6L19 17Z"/></>,
    layers: <><path d="m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5"/></>,
    route: <><circle cx="5" cy="5" r="2"/><circle cx="19" cy="19" r="2"/><path d="M7 5h7a4 4 0 0 1 0 8h-4a3 3 0 0 0 0 6h7"/></>,
    anchor: <><circle cx="12" cy="4" r="2"/><path d="M12 6v15M4 14a8 8 0 0 0 16 0M8 10h8"/></>,
    alert: <><path d="M12 3 2 21h20L12 3Z"/><path d="M12 9v5M12 18h.01"/></>,
    close: <path d="M5 5 19 19M19 5 5 19"/>,
    minus: <path d="M4 12h16"/>,
    plus: <path d="M12 4v16M4 12h16"/>,
    back: <><path d="m14 6-6 6 6 6"/><path d="M20 12H8"/></>,
    settings: <><circle cx="12" cy="12" r="3"/><path d="M10 2h4l1 3 3 1 3-1 2 4-2 2v2l2 2-2 4-3-1-3 1-1 3h-4l-1-3-3-1-3 1-2-4 2-2v-2l-2-2 2-4 3 1 3-1 1-3Z"/></>,
    trend: <><path d="M3 18 10 11l4 4 7-8"/><path d="M15 7h6v6"/></>,
    box: <><path d="m12 2 9 5-9 5-9-5 9-5ZM3 7v10l9 5 9-5V7M12 12v10"/></>,
    target: <><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></>,
    pause: <><path d="M8 5v14M16 5v14"/></>,
    globe: <><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/></>,
    menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
    github: (
      <path d="M9 19c-4.3 1.3-4.3-2.2-6-2.7m12 5.7v-3.9a3.4 3.4 0 0 0-.9-2.7c3-.3 6.2-1.5 6.2-6.9a5.4 5.4 0 0 0-1.5-3.7 5 5 0 0 0-.1-3.7S17.5.8 15 2.5a12.8 12.8 0 0 0-6 0C6.5.8 5.3 1.1 5.3 1.1a5 5 0 0 0-.1 3.7 5.4 5.4 0 0 0-1.5 3.7c0 5.4 3.2 6.6 6.2 6.9A3.4 3.4 0 0 0 9 18.1V22" />
    ),
  };
  return <svg aria-hidden="true" className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>;
}
