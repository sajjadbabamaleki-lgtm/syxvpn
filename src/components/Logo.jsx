/**
 * The cVPN mark.
 *
 * Inline rather than an <img>: it inherits currentColor where a screen wants
 * it in another colour, needs no second request on a network where the second
 * request is the one that fails, and is a few hundred bytes either way.
 *
 * The geometry is traced from the artwork — outer radius 48, inner 27.8, a 62°
 * gap centred on due east, and a block of 20.6 × 17.8 on the same centre. The
 * same shape is in public/logo.svg and in the Android launcher icon; changing
 * one without the others is how a brand ends up with three logos.
 */
export function Logo({ size = 24, className = '', color = '#5CD673' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={className}
      fill={color}
      role="img"
      aria-label="cVPN"
    >
      <path d="M91.14 74.72 A48 48 0 1 1 91.14 25.28 L73.83 35.68 A27.8 27.8 0 1 0 73.83 64.32 Z" />
      <rect x="39.7" y="41.1" width="20.6" height="17.8" />
    </svg>
  );
}
