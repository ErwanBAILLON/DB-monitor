import Link from "next/link";
import { auth, signOut } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  const active = await prisma.alertEvent.count({ where: { resolvedAt: null } }).catch(() => 0);
  return (
    <div className="min-h-screen">
      <header className="border-b border-trait bg-carte">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/app" className="text-base font-semibold tracking-tight">
            DB Monitor
          </Link>
          <nav className="flex gap-4 text-sm text-gris">
            <Link href="/app" className="hover:text-encre">
              Flotte
            </Link>
            <Link href="/app/instances/new" className="hover:text-encre">
              Ajouter
            </Link>
            <Link href="/app/audit" className="hover:text-encre">
              Audit
            </Link>
            <Link href="/app/settings" className="hover:text-encre">
              Réglages
            </Link>
          </nav>
          <div className="ml-auto flex items-center gap-4 text-sm">
            {active > 0 && (
              <span className="rounded-sm bg-panne/15 px-2 py-0.5 font-mono text-xs text-panne" data-testid="alert-badge">
                {active} alerte{active > 1 ? "s" : ""}
              </span>
            )}
            <span className="text-gris">{session?.user?.name}</span>
            <form
              action={async () => {
                "use server";
                await signOut({ redirectTo: "/login" });
              }}
            >
              <button className="btn-ghost py-1">Quitter</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-6">{children}</main>
    </div>
  );
}
