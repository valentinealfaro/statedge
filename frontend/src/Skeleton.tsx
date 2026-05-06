import type { CSSProperties } from 'react';

// Single shimmering placeholder. Width/height are passed as CSS values
// (e.g. "60%", "32px") so callers can match whatever shape they're
// standing in for. The shimmer animation is in index.css.
type Props = {
  width?: string | number;
  height?: string | number;
  radius?: string | number;
  className?: string;
  style?: CSSProperties;
};

export function Skeleton({ width, height, radius, className, style }: Props) {
  const css: CSSProperties = {
    width: typeof width === 'number' ? `${width}px` : width,
    height: typeof height === 'number' ? `${height}px` : height,
    borderRadius: typeof radius === 'number' ? `${radius}px` : radius,
    ...style,
  };
  return <div className={`skeleton${className ? ` ${className}` : ''}`} style={css} />;
}
