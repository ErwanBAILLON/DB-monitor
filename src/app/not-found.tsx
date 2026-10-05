import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-6 py-24 text-center">
      <h1 className="text-2xl font-semibold">Page introuvable</h1>
      <Link href="/app" className="link mt-4 inline-block">
        Retour à la flotte
      </Link>
    </main>
  );
}
