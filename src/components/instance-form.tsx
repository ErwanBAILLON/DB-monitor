"use client";

import { useState } from "react";
import type { Instance } from "@prisma/client";
import { DATABASE_HINT, DEFAULT_PORT, ENGINES, ENGINE_LABEL, type EngineType } from "@/lib/drivers/types";

const HOST_HINT: Record<EngineType, string> = {
  postgres: "shared-postgres-rw.database.svc.cluster.local",
  cockroach: "cockroach-public.projects.svc.cluster.local",
  mysql: "mariadb.projects.svc.cluster.local",
  redis: "redis.projects.svc.cluster.local",
  mongodb: "mongo.projects.svc.cluster.local",
  clickhouse: "clickhouse.projects.svc.cluster.local (port HTTP)",
  opensearch: "opensearch.projects.svc.cluster.local (port HTTP)",
  mssql: "mssql.projects.svc.cluster.local",
  sqlite: "localhost (fichier local au pod)",
};
const USER_HINT: Record<EngineType, string> = {
  postgres: "dbmon",
  cockroach: "root (nœud insecure) ou un rôle dédié",
  mysql: "root ou un compte PROCESS",
  redis: "vide sans ACL, sinon utilisateur ACL",
  mongodb: "root (clusterMonitor + readAnyDatabase)",
  clickhouse: "default",
  opensearch: "admin (vide si sécurité désactivée)",
  mssql: "sa ou un login VIEW SERVER STATE",
  sqlite: "(aucun)",
};

export function InstanceForm({ instance, action, submitLabel }: { instance?: Instance; action: (fd: FormData) => Promise<void>; submitLabel: string }) {
  const i = instance;
  const [type, setType] = useState<EngineType>((i?.type as EngineType) ?? "postgres");
  const [port, setPort] = useState<number>(i?.port ?? DEFAULT_PORT.postgres);
  const onType = (t: EngineType) => {
    setType(t);
    setPort(DEFAULT_PORT[t]);
  };
  return (
    <form action={action} className="grid max-w-2xl grid-cols-1 gap-4 md:grid-cols-2" data-testid="instance-form">
      <label>
        <span className="label">Nom</span>
        <input name="name" className="field" defaultValue={i?.name} required pattern="[\w.\-]{2,64}" placeholder="shared-postgres" />
      </label>
      <label>
        <span className="label">Moteur</span>
        <select name="type" className="field" value={type} onChange={(e) => onType(e.target.value as EngineType)}>
          {ENGINES.map((e) => (
            <option key={e} value={e}>
              {ENGINE_LABEL[e]}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Hôte</span>
        <input name="host" className="field" defaultValue={i?.host} required placeholder={HOST_HINT[type]} />
      </label>
      <label>
        <span className="label">Port</span>
        <input name="port" type="number" className="field" value={port} onChange={(e) => setPort(Number(e.target.value))} min={type === "sqlite" ? 0 : 1} max={65535} required />
      </label>
      <label>
        <span className="label">Utilisateur</span>
        <input name="username" className="field" defaultValue={i?.username ?? ""} autoComplete="off" placeholder={USER_HINT[type]} />
      </label>
      <label>
        <span className="label">Mot de passe {i && <span className="normal-case text-gris">(vide = inchangé)</span>}</span>
        <input name="password" type="password" className="field" autoComplete="new-password" />
      </label>
      <label>
        <span className="label">{DATABASE_HINT[type]}</span>
        <input name="database" className="field" defaultValue={i?.database ?? ""} placeholder={type === "redis" ? "0" : type === "mongodb" ? "admin" : type === "sqlite" ? "/data/sqlite/app.db" : ""} />
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
