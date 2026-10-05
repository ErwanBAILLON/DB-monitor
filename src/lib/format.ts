export function bytes(v: bigint | number | string | null | undefined): string {
  if (v === null || v === undefined) return "–";
  let n = Number(v);
  if (!Number.isFinite(n)) return "–";
  const units = ["o", "Kio", "Mio", "Gio", "Tio"];
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${n < 10 && u > 0 ? n.toFixed(1) : Math.round(n)} ${units[u]}`;
}

export function duration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "–";
  if (sec < 60) return `${sec} s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min`;
  const d = Math.floor(h / 24);
  return `${d} j ${h % 24} h`;
}

export function ago(d: Date | string | null | undefined): string {
  if (!d) return "jamais";
  const sec = Math.round((Date.now() - new Date(d).getTime()) / 1000);
  if (sec < 5) return "à l'instant";
  if (sec < 60) return `il y a ${sec} s`;
  if (sec < 3600) return `il y a ${Math.floor(sec / 60)} min`;
  if (sec < 86400) return `il y a ${Math.floor(sec / 3600)} h`;
  return `il y a ${Math.floor(sec / 86400)} j`;
}

export const dt = (d: Date | string) => new Date(d).toLocaleString("fr-FR", { timeZone: "Europe/Paris" });

export function pct(used: number | null | undefined, max: number | null | undefined): number | null {
  if (used === null || used === undefined || !max) return null;
  return Math.round((100 * used) / max);
}
