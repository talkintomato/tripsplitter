import type { ReactNode } from 'react';

// The icons the app needs, drawn on a 20 px grid with a 1.6 px stroke. They take the colour of the text around
// them and are hidden from screen readers: the button or row they sit in carries the words.
function Icon(props: { size?: number; children: ReactNode }) {
  const size = props.size ?? 20;
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {props.children}
    </svg>
  );
}

export type IconProps = { size?: number };
export type IconComponent = (props: IconProps) => ReactNode;

export const ChevronRight = (p: IconProps) => <Icon size={p.size ?? 16}><path d="M7.5 4.5 13 10l-5.5 5.5" /></Icon>;
export const ChevronLeft = (p: IconProps) => <Icon size={p.size ?? 22}><path d="M12.5 4.5 7 10l5.5 5.5" /></Icon>;
export const ChevronDown = (p: IconProps) => <Icon size={p.size ?? 16}><path d="m5 7.5 5 5 5-5" /></Icon>;
export const Plus = (p: IconProps) => <Icon {...p}><path d="M10 4.5v11M4.5 10h11" /></Icon>;
export const Minus = (p: IconProps) => <Icon {...p}><path d="M4.5 10h11" /></Icon>;
export const Close = (p: IconProps) => <Icon size={p.size ?? 20}><path d="m5.5 5.5 9 9M14.5 5.5l-9 9" /></Icon>;
export const Check = (p: IconProps) => <Icon size={p.size ?? 14}><path d="m4.5 10.5 3.5 3.5 7.5-8" /></Icon>;
export const More = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="4.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="10" cy="10" r="1.1" fill="currentColor" stroke="none" />
    <circle cx="15.5" cy="10" r="1.1" fill="currentColor" stroke="none" />
  </Icon>
);
export const Pencil = (p: IconProps) => <Icon {...p}><path d="M12.8 4.2a1.8 1.8 0 0 1 2.6 2.6L7.2 15l-3.4.8.8-3.4 8.2-8.2ZM11.5 5.5l3 3" /></Icon>;
export const Trash = (p: IconProps) => <Icon {...p}><path d="M4 6h12M8 6V4.5h4V6M5.5 6l.7 9.5h7.6l.7-9.5M8.5 9v4M11.5 9v4" /></Icon>;
/** Money moving from one person to another: a payment. */
export const Transfer = (p: IconProps) => <Icon {...p}><path d="M3.5 7h12M12.5 4l3 3-3 3M16.5 13h-12M7.5 10l-3 3 3 3" /></Icon>;
export const Receipt = (p: IconProps) => <Icon {...p}><path d="M5 3.5h10v13l-2-1.3-1.7 1.3-1.3-1.3-1.3 1.3L7 15.2l-2 1.3v-13ZM7.5 7h5M7.5 10h5M7.5 13h2.5" /></Icon>;
export const People = (p: IconProps) => (
  <Icon {...p}>
    <circle cx="7.5" cy="7" r="2.75" />
    <path d="M2.5 16c.4-2.7 2.4-4.25 5-4.25s4.6 1.55 5 4.25M13 4.6a2.75 2.75 0 0 1 0 4.9M14.8 12.2c1.5.6 2.4 1.9 2.7 3.8" />
  </Icon>
);
export const Clock = (p: IconProps) => <Icon {...p}><circle cx="10" cy="10" r="7" /><path d="M10 6v4.25l2.75 1.75" /></Icon>;
export const Coins = (p: IconProps) => (
  <Icon {...p}>
    <ellipse cx="8" cy="6" rx="4.5" ry="2" />
    <path d="M3.5 6v3c0 1.1 2 2 4.5 2s4.5-.9 4.5-2V6M3.5 9v3c0 1.1 2 2 4.5 2 .7 0 1.3-.1 1.9-.2" />
    <circle cx="13.5" cy="13" r="3" />
  </Icon>
);
export const Flag = (p: IconProps) => <Icon {...p}><path d="M5 17V3.5M5 4h8.5l-1.5 3 1.5 3H5" /></Icon>;
export const Archive = (p: IconProps) => <Icon {...p}><path d="M3.5 4.5h13v3h-13zM4.5 7.5v8h11v-8M8 10.5h4" /></Icon>;
export const Grid = (p: IconProps) => <Icon {...p}><rect x="3.5" y="3.5" width="5" height="5" rx="1.2" /><rect x="11.5" y="3.5" width="5" height="5" rx="1.2" /><rect x="3.5" y="11.5" width="5" height="5" rx="1.2" /><rect x="11.5" y="11.5" width="5" height="5" rx="1.2" /></Icon>;
export const LinkIcon = (p: IconProps) => <Icon {...p}><path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.8.8M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 0 0 4.2 4.2l.8-.8" /></Icon>;
export const Restore = (p: IconProps) => <Icon {...p}><path d="M4 10a6 6 0 1 0 1.8-4.3M4 3.5v3h3" /></Icon>;
export const Alert = (p: IconProps) => <Icon {...p}><circle cx="10" cy="10" r="7" /><path d="M10 6.5v4M10 13.5v.01" /></Icon>;
export const Info = (p: IconProps) => <Icon {...p}><circle cx="10" cy="10" r="7" /><path d="M10 9v4.5M10 6.5v.01" /></Icon>;
export const Calendar = (p: IconProps) => <Icon {...p}><rect x="3.5" y="4.5" width="13" height="12" rx="2" /><path d="M3.5 8.5h13M7 3v3M13 3v3" /></Icon>;

// Tiles for expense rows, picked from words in the title. A plain receipt when nothing matches.
export const Food = (p: IconProps) => <Icon {...p}><path d="M6 3v5a2 2 0 0 0 4 0V3M8 8v9M14 3c-1.5 1-2 3-2 5s1 2.5 2 2.5V17" /></Icon>;
export const Coffee = (p: IconProps) => <Icon {...p}><path d="M4 8h10v4a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V8ZM14 9h1a2 2 0 0 1 0 4h-1M7 3.5v2M10 3.5v2" /></Icon>;
export const Car = (p: IconProps) => <Icon {...p}><path d="M4 12.5 5.3 7.9A2 2 0 0 1 7.2 6.5h5.6a2 2 0 0 1 1.9 1.4L16 12.5M3.5 12.5h13v3h-13zM5.5 15.5v1.5M14.5 15.5v1.5" /><circle cx="6.5" cy="14" r=".6" fill="currentColor" /><circle cx="13.5" cy="14" r=".6" fill="currentColor" /></Icon>;
export const Train = (p: IconProps) => <Icon {...p}><rect x="5" y="3" width="10" height="11" rx="2.5" /><path d="M5 9h10M7.5 17l1-3M12.5 17l-1-3" /><circle cx="7.8" cy="11.6" r=".6" fill="currentColor" /><circle cx="12.2" cy="11.6" r=".6" fill="currentColor" /></Icon>;
export const Plane = (p: IconProps) => <Icon {...p}><path d="M17 4.5 3 9.5l5 1.5 1.5 5 7.5-11.5ZM8 11l4-3" /></Icon>;
export const Bed = (p: IconProps) => <Icon {...p}><path d="M3 15.5v-9M3 12.5h14v3M17 12.5v-2a2 2 0 0 0-2-2H9v4" /><circle cx="6" cy="10" r="1.5" /></Icon>;
export const Ticket = (p: IconProps) => <Icon {...p}><path d="M3.5 6.5h13v2a1.5 1.5 0 0 0 0 3v2h-13v-2a1.5 1.5 0 0 0 0-3v-2ZM11.5 6.5v7" /></Icon>;
export const Cart = (p: IconProps) => <Icon {...p}><path d="M3 4h2l1.6 8h8.2L16.5 6.5H6" /><circle cx="7.5" cy="15.5" r="1.2" /><circle cx="14" cy="15.5" r="1.2" /></Icon>;
export const Glass = (p: IconProps) => <Icon {...p}><path d="M5.5 3.5h9l-1 5.5a3.5 3.5 0 0 1-7 0l-1-5.5ZM10 12.5v4M7 16.5h6" /></Icon>;
export const Smile = (p: IconProps) => <Icon {...p}><circle cx="10" cy="10" r="7" /><path d="M7 11.5c.7 1 1.8 1.6 3 1.6s2.3-.6 3-1.6" /><circle cx="7.6" cy="8.2" r=".7" fill="currentColor" /><circle cx="12.4" cy="8.2" r=".7" fill="currentColor" /></Icon>;
