import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

export type AuditInput = {
  actor: string;
  instance?: { id: string; name: string } | null;
  action: string;
  params?: Record<string, unknown>;
};

// Runs `fn`, records the outcome (never the secrets: callers pass only safe params)
// and rethrows so the UI shows the error.
export async function audited<T>(input: AuditInput, fn: () => Promise<T>, summarize?: (r: T) => string): Promise<T> {
  try {
    const r = await fn();
    await prisma.audit.create({
      data: {
        actor: input.actor,
        instanceId: input.instance?.id ?? null,
        instanceName: input.instance?.name ?? null,
        action: input.action,
        params: (input.params ?? {}) as Prisma.InputJsonValue,
        ok: true,
        result: summarize ? summarize(r).slice(0, 2000) : "ok",
      },
    });
    return r;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.audit
      .create({
        data: {
          actor: input.actor,
          instanceId: input.instance?.id ?? null,
          instanceName: input.instance?.name ?? null,
          action: input.action,
          params: (input.params ?? {}) as Prisma.InputJsonValue,
          ok: false,
          result: message.slice(0, 2000),
        },
      })
      .catch(() => undefined);
    throw err;
  }
}
