"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export default function LoginPage() {
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    const form = new FormData(event.currentTarget);
    const result = await signIn("credentials", { username: form.get("username"), password: form.get("password"), redirect: false });
    if (result?.error) {
      setError(true);
      setBusy(false);
    } else window.location.href = "/app";
  }

  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      <p className="font-mono text-xs uppercase tracking-widest text-gris">homelab</p>
      <h1 className="mt-1 text-3xl font-semibold tracking-tight">DB Monitor</h1>
      <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-4">
        <input name="username" placeholder="Identifiant" className="field" autoComplete="username" required />
        <input name="password" type="password" placeholder="Mot de passe" className="field" autoComplete="current-password" required />
        {error && <p className="text-sm text-panne">Identifiants invalides.</p>}
        <button type="submit" className="btn mt-2" disabled={busy}>
          Se connecter
        </button>
      </form>
    </main>
  );
}
