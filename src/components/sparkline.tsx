// Latency sparkline: null points (down) drawn as red ticks on the baseline.
export function Sparkline({ points, width = 120, height = 28 }: { points: (number | null)[]; width?: number; height?: number }) {
  if (!points.length) return <svg width={width} height={height} aria-hidden />;
  const vals = points.filter((p): p is number => p !== null);
  const max = Math.max(5, ...vals);
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const d: string[] = [];
  const downs: number[] = [];
  points.forEach((p, i) => {
    const x = i * step;
    if (p === null) {
      downs.push(x);
      return;
    }
    const y = height - 2 - (p / max) * (height - 4);
    d.push(`${d.length === 0 || points[i - 1] === null ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`);
  });
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-label={`latence, max ${max} ms`} className="overflow-visible">
      <path d={d.join(" ")} fill="none" stroke="rgb(var(--accent))" strokeWidth="1.5" strokeLinejoin="round" />
      {downs.map((x) => (
        <line key={x} x1={x} x2={x} y1={height - 6} y2={height} stroke="rgb(var(--panne))" strokeWidth="2" />
      ))}
    </svg>
  );
}
