import type { Instance } from "@prisma/client";
import * as s3 from "@/lib/drivers/s3";
import type { Conn } from "@/lib/drivers/types";
import { DataTable } from "@/components/data-table";
import { bytes } from "@/lib/format";

export const s3TabList = [{ key: "buckets", label: "Buckets" }];

export async function S3Tabs({ conn, tab }: { inst: Instance; conn: Conn; tab: string }) {
  if (tab !== "buckets") return null;
  const d = await s3.detail(conn);
  return (
    <div className="space-y-4">
      <div className="card">
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
          <dt className="text-gris">Serveur</dt>
          <dd className="font-mono">{d.server ?? "S3"}</dd>
          <dt className="text-gris">Buckets</dt>
          <dd className="font-mono" data-testid="s3-buckets">
            {d.buckets.length}
          </dd>
          <dt className="text-gris">Objets</dt>
          <dd className="font-mono">
            {d.anyCapped ? ">= " : ""}
            {d.totalObjects}
          </dd>
          <dt className="text-gris">Volume</dt>
          <dd className="font-mono">
            {d.anyCapped ? ">= " : ""}
            {bytes(d.totalBytes)}
          </dd>
        </dl>
        <p className="mt-2 text-xs text-gris">Comptage par ListObjectsV2 paginé (1000 par page), arrêté après {s3.OBJECT_CAP} objets par bucket (valeurs alors préfixées de « &gt;= »). Lecture seule : aucune action sur les objets.</p>
      </div>
      <DataTable rows={d.buckets} columns={["name", "objects", "size", "last_modified", "region", "versioning", "created", "error"]} empty="Aucun bucket visible avec cette clé." />
    </div>
  );
}
