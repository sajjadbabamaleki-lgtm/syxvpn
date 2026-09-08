import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

/**
 * Renders a QR code as inline SVG.
 *
 * A QR code is the only import path that works on every client app, including
 * ones with no URL scheme of their own, so it is the primary way a config
 * leaves this screen. SVG keeps it crisp on any density and adds no canvas or
 * image bytes to the page.
 */
export function Qr({ value, size = 220, label }) {
  const path = useMemo(() => {
    if (!value) return null;
    // Type 0 = let the library pick the smallest version that fits.
    const qr = qrcode(0, 'M');
    qr.addData(value);
    qr.make();
    const count = qr.getModuleCount();
    const parts = [];
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) parts.push(`M${col} ${row}h1v1h-1z`);
      }
    }
    return { d: parts.join(''), count };
  }, [value]);

  if (!path) return null;

  return (
    <div className="qr" style={{ width: size, height: size }}>
      <svg
        viewBox={`-1 -1 ${path.count + 2} ${path.count + 2}`}
        width={size}
        height={size}
        role="img"
        aria-label={label || 'QR code'}
        shapeRendering="crispEdges"
      >
        <rect x="-1" y="-1" width={path.count + 2} height={path.count + 2} fill="#ffffff" />
        <path d={path.d} fill="#000000" />
      </svg>
    </div>
  );
}
