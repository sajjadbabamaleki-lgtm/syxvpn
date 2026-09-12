/**
 * The app's mark.
 *
 * Five shapes, 42 corners, every edge straight, white over a lime light. This
 * used to be the old product's C, in a green nothing else on the site used —
 * left alone through the rename on the grounds that artwork is decided once
 * and on purpose. It has now been decided: the same artwork is on the Android
 * launcher icon, in public/logo.svg and in the three pages' favicons.
 *
 * The light is a gradient rather than a blur filter. A filter is truer to the
 * artwork and is also the first thing that fails when an SVG is inlined into a
 * data URI, and one mark that renders identically in five places is worth more
 * than a slightly softer one that does not.
 *
 * Inline rather than an <img>: it needs no second request on a network where
 * the second request is the one that fails.
 *
 * The gradient needs an id, and two of these on one page must not share it —
 * so it is derived from the size, which is what actually differs between the
 * places this is used.
 */
const PATHS = [
  'M20.15,14.16 32.30,34.48 90.38,52.09 92.20,55.54 92.20,75.32 91.29,77.68 79.49,85.84 67.51,65.52 12.52,49.36 9.44,47.91 7.80,45.37 7.80,23.96 9.98,21.05 19.96,14.34Z',
  'M42.11,0.00 58.62,0.18 70.05,7.62 50.82,27.95 49.91,28.68 29.76,7.62 39.38,1.09 41.92,0.18Z',
  'M49.73,71.51 70.05,92.38 59.71,99.46 57.89,100.00 41.02,99.82 29.95,92.56 49.55,71.69Z',
  'M79.67,14.16 91.47,22.69 92.20,24.68 92.20,36.84 66.42,36.84 79.49,14.34Z',
  'M7.99,63.16 33.39,63.34 20.69,85.48 19.96,85.84 8.35,77.31 7.80,76.04 7.80,63.34Z',
];

const LIME = '#d8f83a';

export function Logo({ size = 24, className = '', color = '#ffffff' }) {
  const id = `syx-light-${size}`;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      role="img"
      aria-label="SyxVPN"
    >
      <defs>
        <radialGradient id={id} gradientUnits="userSpaceOnUse" cx="50" cy="50" r="40">
          <stop offset="0" stopColor={LIME} stopOpacity=".95" />
          <stop offset=".35" stopColor={LIME} stopOpacity=".55" />
          <stop offset=".7" stopColor={LIME} stopOpacity=".16" />
          <stop offset="1" stopColor={LIME} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="50" cy="50" r="40" fill={`url(#${id})`} />
      <g fill={color}>
        {PATHS.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
