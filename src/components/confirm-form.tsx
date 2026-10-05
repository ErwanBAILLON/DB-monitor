"use client";

import { useFormStatus } from "react-dom";
import { useState } from "react";

function Submit({ label, danger }: { label: string; danger?: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={danger ? "btn-danger" : "btn"} disabled={pending}>
      {pending ? "…" : label}
    </button>
  );
}

// A server-action form with a native confirm() gate and inline result display.
export function ConfirmForm({
  action,
  confirm,
  label,
  danger,
  children,
  className,
  testId,
}: {
  action: (fd: FormData) => Promise<{ ok: boolean; message: string }>;
  confirm?: string;
  label: string;
  danger?: boolean;
  children?: React.ReactNode;
  className?: string;
  testId?: string;
}) {
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  return (
    <form
      className={className ?? "flex flex-wrap items-end gap-2"}
      data-testid={testId}
      action={async (fd) => {
        if (confirm && !window.confirm(confirm)) return;
        setResult(null);
        try {
          setResult(await action(fd));
        } catch (err) {
          setResult({ ok: false, message: err instanceof Error ? err.message : String(err) });
        }
      }}
    >
      {children}
      <Submit label={label} danger={danger} />
      {result && (
        <output className={`basis-full whitespace-pre-wrap font-mono text-xs ${result.ok ? "text-ok" : "text-panne"}`} data-testid="result">
          {result.message}
        </output>
      )}
    </form>
  );
}
