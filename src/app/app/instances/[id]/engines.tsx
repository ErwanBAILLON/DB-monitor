import type { Instance } from "@prisma/client";
import type { Conn, EngineType } from "@/lib/drivers/types";
import { PostgresTabs, postgresTabList } from "./postgres";
import { CockroachTabs, cockroachTabList } from "./cockroach";
import { RedisTabs, redisTabList } from "./redis";
import { MysqlTabs, mysqlTabList } from "./mysql";
import { MongoTabs, mongoTabList } from "./mongodb";
import { ClickhouseTabs, clickhouseTabList } from "./clickhouse";
import { OpensearchTabs, opensearchTabList } from "./opensearch";
import { MssqlTabs, mssqlTabList } from "./mssql";
import { SqliteTabs, sqliteTabList } from "./sqlite";
import { CassandraTabs, cassandraTabList } from "./cassandra";
import { InfluxTabs, influxTabList } from "./influxdb";
import { Neo4jTabs, neo4jTabList } from "./neo4j";
import { EtcdTabs, etcdTabList } from "./etcd";

export type TabDef = { key: string; label: string };
export type EngineTabs = { tabs: TabDef[]; render: (p: { inst: Instance; conn: Conn; tab: string }) => Promise<React.ReactNode> };

// One entry per engine: its detail tabs and the server component rendering them.
export const ENGINE_TABS: Record<EngineType, EngineTabs> = {
  postgres: { tabs: postgresTabList, render: PostgresTabs },
  cockroach: { tabs: cockroachTabList, render: CockroachTabs },
  redis: { tabs: redisTabList, render: RedisTabs },
  mysql: { tabs: mysqlTabList, render: MysqlTabs },
  mongodb: { tabs: mongoTabList, render: MongoTabs },
  clickhouse: { tabs: clickhouseTabList, render: ClickhouseTabs },
  opensearch: { tabs: opensearchTabList, render: OpensearchTabs },
  mssql: { tabs: mssqlTabList, render: MssqlTabs },
  sqlite: { tabs: sqliteTabList, render: SqliteTabs },
  cassandra: { tabs: cassandraTabList, render: CassandraTabs },
  influxdb: { tabs: influxTabList, render: InfluxTabs },
  neo4j: { tabs: neo4jTabList, render: Neo4jTabs },
  etcd: { tabs: etcdTabList, render: EtcdTabs },
};
