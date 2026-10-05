import { InstanceForm } from "@/components/instance-form";
import { ConfirmForm } from "@/components/confirm-form";
import { addInstance, testConnection } from "@/app/app/actions";

export const metadata = { title: "Nouvelle instance" };

export default function NewInstancePage() {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-tight">Nouvelle instance</h1>
      <p className="mt-1 text-sm text-gris">Le mot de passe est chiffré (AES-256-GCM) avant stockage. Testez la connexion avant d&apos;enregistrer.</p>
      <div className="card mt-5">
        <InstanceForm action={addInstance} submitLabel="Enregistrer" />
      </div>
      <details className="card mt-4">
        <summary className="cursor-pointer text-sm font-medium">Tester une connexion sans enregistrer</summary>
        <p className="mt-2 text-xs text-gris">Renseignez le même formulaire ici ; rien n&apos;est stocké ni journalisé (hors tentative).</p>
        <div className="mt-3">
          <ConfirmForm action={testConnection} label="Tester" className="grid max-w-2xl grid-cols-2 gap-2" testId="test-form">
            <input name="type" className="field" placeholder="postgres | mysql | redis" defaultValue="postgres" />
            <input name="name" className="field" placeholder="nom (temporaire)" defaultValue="test" />
            <input name="host" className="field" placeholder="hôte" />
            <input name="port" className="field" placeholder="port" defaultValue="5432" />
            <input name="username" className="field" placeholder="utilisateur" />
            <input name="password" type="password" className="field" placeholder="mot de passe" />
            <input name="database" className="field" placeholder="base" />
            <label className="flex items-center gap-2 text-sm">
              <input name="tls" type="checkbox" /> TLS
            </label>
          </ConfirmForm>
        </div>
      </details>
    </>
  );
}
