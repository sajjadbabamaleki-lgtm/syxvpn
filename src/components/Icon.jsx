/**
 * Inline icon set. Replaces lucide-react: the dashboard needs about a dozen
 * glyphs and shipping an icon library for that costs bundle size the target
 * network conditions cannot afford.
 */
const PATHS = {
  overview: 'M3 12l9-8 9 8M5 10v10h14V10',
  gateway: 'M4 5h16v6H4zM4 15h16v4H4zM8 8h.01M8 17h.01',
  route: 'M5 19a3 3 0 100-6 3 3 0 000 6zM19 11a3 3 0 100-6 3 3 0 000 6zM8 16h5a3 3 0 003-3V8',
  users: 'M16 20v-1a4 4 0 00-4-4H7a4 4 0 00-4 4v1M9.5 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-1a4 4 0 00-3-3.9',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  plus: 'M12 5v14M5 12h14',
  check: 'M4 12.5l5 5L20 6.5',
  refresh: 'M20 11a8 8 0 10-1.6 5.6M20 5v6h-6',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  back: 'M15 5l-7 7 7 7',
  chevron: 'M9 5l7 7-7 7',
  alert: 'M12 8v5M12 17h.01M10.3 3.9L2.6 17a2 2 0 001.7 3h15.4a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z',
  activity: 'M3 12h4l3 8 4-16 3 8h4',
  key: 'M14 8a4 4 0 11-3.5 5.9L4 20.4 3 19l1.5-1.5L3 16l1.5-1.5L3 13l7.1-7.1A4 4 0 0114 8z',
  lab: 'M9 3h6M10 3v6l-5 9a2 2 0 001.7 3h10.6a2 2 0 001.7-3l-5-9V3',
  settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-2.7 1.1V21a2 2 0 11-4 0v-.1A1.6 1.6 0 007 19.4l-.1.1a2 2 0 11-2.8-2.8l.1-.1A1.6 1.6 0 003 15H3a2 2 0 110-4h.1A1.6 1.6 0 004.6 7l-.1-.1a2 2 0 112.8-2.8l.1.1A1.6 1.6 0 0010 4.6V4a2 2 0 114 0v.1A1.6 1.6 0 0016.9 5l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8v.1a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z',
  globe: 'M12 21a9 9 0 100-18 9 9 0 000 18zM3 12h18M12 3a14 14 0 010 18 14 14 0 010-18z',
  signal: 'M5 20v-4M10 20V10M15 20V6M20 20V13',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  logout: 'M15 16l4-4-4-4M19 12H9M11 4H6a2 2 0 00-2 2v12a2 2 0 002 2h5',
  search: 'M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4',
  close: 'M6 6l12 12M18 6L6 18',
  clock: 'M12 21a9 9 0 100-18 9 9 0 000 18zM12 7v5l3 2',
  shield: 'M12 3l8 3v6c0 5-3.4 8.3-8 9-4.6-.7-8-4-8-9V6l8-3z',
};

export function Icon({ name, size = 20, className = '', strokeWidth = 1.7 }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={d} />
    </svg>
  );
}
