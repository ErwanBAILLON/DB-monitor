"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

// Re-renders the server component tree every `seconds` (fleet view: 30 s).
export function AutoRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    const t = setInterval(() => {
      setLeft((l) => {
        if (l <= 1) {
          router.refresh();
          return seconds;
        }
        return l - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [router, seconds]);
  return (
    <span className="font-mono text-xs text-gris" title="Rafraîchissement automatique">
      ↻ {left} s
    </span>
  );
}
