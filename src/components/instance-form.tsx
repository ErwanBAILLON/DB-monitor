import type { Instance } from "@prisma/client";
import { DEFAULT_PORT, ENGINES, ENGINE_LABEL } from "@/lib/drivers/types";

export function InstanceForm({ instance, action, submitLabel }: { instance?: Instance; action: (fd: FormData) => Promise<void>; submitLabel: string }) {
  const i = instance;
  return (
    <form action={action} className="grid max-w-2xl grid-cols-1 gap-4 md:grid-cols-2" data-testid="instance-form">
      <label>
        <span className="label">Nom</span>
        <input name="name" className="field" defaultValue={i?.name} required pattern="[\w.\-]{2,64}" placeholder="shared-postgres" />
      </label>
      <label>
        <span className="label">Moteur</span>
        <select name="type" className="field" defaultValue={i?.type ?? "postgres"}>
          {ENGINES.map((e) => (
            <option key={e} value={e}>
              {ENGINE_LABEL[e]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Hôte</span>
        <input name="host" className="field" defaultValue={i?.host} required placeholder="svc.namespace.svc.cluster.local" />
      </label>
      <label>
        <span className="label">Port</span>
        <input name="port" type="number" className="field" defaultValue={i?.port ?? DEFAULT_PORT.postgres} min={1} max={65535} required />
      </label>
      <label>
        <span className="label">Utilisateur</span>
        <input name="username" className="field" defaultValue={i?.username ?? ""} autoComplete="off" placeholder="dbmon (vide pour Redis sans ACL)" />
      </label>
      <label>
        <span className="label">Mot de passe {i && <span className="normal-case text-gris">(vide = inchangé)</span>}</span>
        <input name="password" type="password" className="field" autoComplete="new-password" />
      </label>
      <label>
        <span className="label">Base par défaut / n° db Redis</span>
        <input name="database" className="field" defaultValue={i?.database ?? ""} placeholder="postgres" />
      </label>
      <label>
        <span className="label">Environnement</span>
        <input name="environment" className="field" defaultValue={i?.environment ?? "prod"} list="envs" />
        <datalist id="envs">
          <option>prod</option>
          <option>staging</option>
          <option>dev</option>
          <option>local</option>
        </datalist>
      </label>
      <label className="md:col-span-2">
        <span className="label">Tags (séparés par des virgules)</span>
        <input name="tags" className="field" defaultValue={i?.tags.join(", ")} placeholder="cnpg, shared" />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input name="tls" type="checkbox" defaultChecked={i?.tls} /> TLS (certificat non vérifié : CA interne)
      </label>
      <div className="md:col-span-2">
        <button type="submit" className="btn">
          {submitLabel}
        </button>
      </div>
    </form>
  );
}
