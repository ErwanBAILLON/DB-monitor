// End-to-end run against a running server (local or prod).
//   BASE=http://127.0.0.1:3140 ADMIN_PASSWORD=... PG_HOST=127.0.0.1 PG_PORT=5490 node scripts/e2e.cjs
// Prod (read-only, uses an already registered instance):
//   BASE=https://<host> RESOLVE_IP=<ingress-ip> READONLY=1 INSTANCE=<registered-instance> node scripts/e2e.cjs
// Needs Playwright (PLAYWRIGHT=path to the module).
const PW = process.env.PLAYWRIGHT || "playwright";
const { chromium } = require(PW);
const fs = require("fs");

const BASE = (process.env.BASE || "http://127.0.0.1:3140").replace(/\/$/, "");
const SHOTS = process.env.SHOTS || "/tmp/dbmon-shots";
const ADMIN = { user: process.env.ADMIN_USERNAME || "admin", pass: process.env.ADMIN_PASSWORD || "localadmin123" };
const RESOLVE = process.env.RESOLVE_IP;
const READONLY = process.env.READONLY === "1";
const TAG = Date.now().toString(36);
const INSTANCE = process.env.INSTANCE || `e2e-pg-${TAG}`;
const PG = { host: process.env.PG_HOST || "127.0.0.1", port: process.env.PG_PORT || "5490", user: process.env.PG_USER || "postgres", pass: process.env.PG_PASS || "" };
fs.mkdirSync(SHOTS, { recursive: true });

const log = (m) => console.log(`[e2e] ${m}`);
const fail = (m) => {
  throw new Error(m);
};
async function shot(page, name) {
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (overflow > 1) log(`WARN horizontal overflow ${overflow}px on ${name}`);
}

(async () => {
  const args = RESOLVE ? [`--host-resolver-rules=MAP ${new URL(BASE).hostname} ${RESOLVE}`] : [];
  const browser = await chromium.launch({ args });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "fr-FR", ignoreHTTPSErrors: !!RESOLVE });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  // 1. Login (unauthenticated /app redirects to /login).
  await page.goto(`${BASE}/app`);
  await page.waitForURL(/\/login/);
  await shot(page, "01-login");
  await page.fill('input[name="username"]', ADMIN.user);
  await page.fill('input[name="password"]', "wrong-" + TAG);
  await page.click('button[type="submit"]');
  await page.getByText("Identifiants invalides").waitFor();
  await page.fill('input[name="password"]', ADMIN.pass);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app$/);
  log("logged in");

  // 2. Fleet.
  await page.getByTestId("fleet-summary").waitFor();
  await shot(page, "02-fleet");
  const cards = await page.getByTestId("instance-card").count();
  log(`fleet shows ${cards} instance(s)`);

  let instanceUrl;
  if (!READONLY) {
    // 3a. A host outside DBMON_ALLOWED_TARGETS is refused (the server sets 127.0.0.1 + cluster suffixes).
    if (process.env.DENIED_HOST) {
      await page.goto(`${BASE}/app/instances/new`);
      const f0 = page.getByTestId("instance-form");
      await f0.locator('[name="name"]').fill(`denied-${TAG}`);
      await f0.locator('[name="host"]').fill(process.env.DENIED_HOST);
      await f0.locator('[name="port"]').fill("80");
      await f0.locator('button[type="submit"]').click();
      await page.getByTestId("form-error").filter({ hasText: /hors de la liste autorisée/ }).waitFor();
      log(`denied host refused: ${process.env.DENIED_HOST}:80`);
    }
    // 3. Add the local Postgres instance (test connection first, then save).
    await page.goto(`${BASE}/app/instances/new`);
    await shot(page, "03-new");
    const form = page.getByTestId("instance-form");
    await form.locator('[name="name"]').fill(INSTANCE);
    await form.locator('[name="type"]').selectOption("postgres");
    await form.locator('[name="host"]').fill(PG.host);
    await form.locator('[name="port"]').fill(PG.port);
    await form.locator('[name="username"]').fill(PG.user);
    if (PG.pass) await form.locator('[name="password"]').fill(PG.pass);
    await form.locator('[name="database"]').fill("postgres");
    await form.locator('[name="environment"]').fill("local");
    await form.locator('[name="tags"]').fill("e2e, portable");
    await form.locator('button[type="submit"]').click();
    await page.waitForURL(/\/app\/instances\/(?!new$)[a-z0-9]+$/);
    instanceUrl = page.url().split("?")[0];
    log(`instance created ${instanceUrl}`);
    // Overview shows the first check (addInstance probes synchronously).
    await page.getByTestId("last-state").waitFor();
    const state = await page.getByTestId("last-state").innerText();
    if (!/^up/.test(state)) fail(`instance not up after creation: ${state}`);
    await shot(page, "04-overview");

    // Fleet shows it up.
    await page.goto(`${BASE}/app`);
    const card = page.locator(`[data-testid="instance-card"][data-name="${INSTANCE}"]`);
    await card.waitFor();
    const st = await card.getByTestId("status").getAttribute("data-status");
    if (st !== "up") fail(`fleet status ${st}`);
    log("fleet card up");
    await shot(page, "05-fleet-with-instance");
  } else {
    const card = page.locator(`[data-testid="instance-card"][data-name="${INSTANCE}"]`);
    if (!(await card.count())) fail(`instance ${INSTANCE} not in fleet`);
    const st = await card.getByTestId("status").getAttribute("data-status");
    log(`${INSTANCE} status ${st}`);
    if (st !== "up") fail(`seeded instance not up: ${st}`);
    await card.locator("a").first().click();
    await page.waitForURL(/\/app\/instances\/(?!new$)[a-z0-9]+$/);
    instanceUrl = page.url().split("?")[0];
  }

  // 4. Test connection button.
  await page.goto(instanceUrl);
  const test = page.getByTestId("test-connection");
  await test.locator("button").click();
  await test.getByTestId("result").waitFor();
  const tr = await test.getByTestId("result").innerText();
  if (!/Connexion OK/.test(tr)) fail(`test connection: ${tr}`);
  log(tr);

  // 5. Detail tabs.
  for (const tab of ["databases", "sessions", "locks", "tables", "roles", "settings-pg"]) {
    await page.goto(`${instanceUrl}?tab=${tab}`);
    if (await page.getByTestId("engine-error").count()) fail(`tab ${tab}: ${await page.getByTestId("engine-error").innerText()}`);
    // "tables" may legitimately be empty on a fresh server.
    await page.locator(tab === "tables" ? "table.tbl, section p" : "table.tbl").first().waitFor();
    await shot(page, `06-${tab}`);
  }
  log("tabs rendered");

  // 6. Read-only query: a SELECT works, a DELETE is refused.
  await page.goto(`${instanceUrl}?tab=query`);
  await page.fill('textarea[name="sql"]', "SELECT datname, pg_size_pretty(pg_database_size(oid)) AS size FROM pg_database ORDER BY 1");
  await page.click('button:has-text("Exécuter")');
  await page.getByTestId("query-result").waitFor();
  const n = await page.getByTestId("query-result").locator("tbody tr").count();
  if (n < 1) fail("query returned no rows");
  log(`query returned ${n} rows`);
  await shot(page, "07-query");
  await page.fill('textarea[name="sql"]', "DELETE FROM pg_database");
  await page.click('button:has-text("Exécuter")');
  await page.getByTestId("query-error").waitFor();
  log(`write refused: ${await page.getByTestId("query-error").innerText()}`);
  // Side-effect function hidden in a quoted identifier (review finding) must be refused too.
  await page.fill('textarea[name="sql"]', 'SELECT "pg_sleep"(0)');
  await page.click('button:has-text("Exécuter")');
  await page.getByTestId("query-error").filter({ hasText: /guillemets/ }).waitFor();
  log(`quoted function refused: ${await page.getByTestId("query-error").innerText()}`);
  await page.fill('textarea[name="sql"]', "SELECT pg_notify('x','y')");
  await page.click('button:has-text("Exécuter")');
  await page.getByTestId("query-error").filter({ hasText: /pg_notify/ }).waitFor();
  log(`pg_notify refused: ${await page.getByTestId("query-error").innerText()}`);

  // 7. Create a database with owner (local only).
  const dbName = `e2e_${TAG}`;
  if (!READONLY) {
    await page.goto(`${instanceUrl}?tab=actions`);
    const f = page.getByTestId("create-db-form");
    await f.locator('[name="name"]').fill(dbName);
    await f.locator('[name="owner"]').fill(dbName);
    await f.locator('button[type="submit"]').click();
    await f.getByTestId("result").waitFor();
    const r = await f.getByTestId("result").innerText();
    if (!/créée/.test(r) || !/postgresql:\/\//.test(r)) fail(`create db: ${r}`);
    log("database created with owner, URL shown once");
    await shot(page, "08-create-db");
    await page.goto(`${instanceUrl}?tab=databases`);
    await page.locator(`td[title="${dbName}"]`).first().waitFor();
    // dump link present and downloadable (needs pg_dump next to the server; SKIP_DUMP=1 otherwise)
    if (process.env.SKIP_DUMP === "1") log("dump skipped (SKIP_DUMP=1)");
    else {
    const [dl] = await Promise.all([page.waitForEvent("download"), page.locator(`tr:has(td[title="${dbName}"]) a:has-text("dump")`).click()]);
    const path = await dl.path();
    const size = fs.statSync(path).size;
    if (size < 20) fail(`dump too small (${size} b)`);
    log(`dump downloaded ${dl.suggestedFilename()} ${size} b`);
    }
  }

  // 7b. Prod: pg_dump of a small database through the authenticated session (read-only on the server).
  if (READONLY && process.env.DUMP_DB) {
    const res = await page.request.get(`${instanceUrl.replace("/app/instances/", "/api/instances/")}/dump?db=${process.env.DUMP_DB}`);
    if (!res.ok()) fail(`dump ${res.status()}`);
    const body = await res.body();
    if (body.length < 100 || body[0] !== 0x1f || body[1] !== 0x8b) fail(`dump not gzip (${body.length} b)`);
    log(`dump of ${process.env.DUMP_DB}: ${body.length} b gzip`);
  }

  // 8. Audit shows the rows.
  await page.goto(`${BASE}/app/audit`);
  await page.getByTestId("audit-table").waitFor();
  const actions = await page.locator("tbody tr").evaluateAll((trs) => trs.map((t) => t.getAttribute("data-action")));
  for (const a of ["instance.test", "query.readonly", ...(READONLY && process.env.DUMP_DB ? ["pg_dump"] : []), ...(READONLY ? [] : ["instance.create", "pg.create_database", ...(process.env.SKIP_DUMP === "1" ? [] : ["pg_dump"])])]) {
    if (!actions.includes(a)) fail(`audit missing ${a} (have ${actions.slice(0, 10).join(",")})`);
  }
  log(`audit ok (${actions.length} rows on page)`);
  await shot(page, "09-audit");

  // 9. /api/alerts with the session cookie; settings page.
  const alerts = await page.request.get(`${BASE}/api/alerts`);
  if (!alerts.ok()) fail(`/api/alerts ${alerts.status()}`);
  log(`/api/alerts ${JSON.stringify(await alerts.json()).slice(0, 120)}`);
  await page.goto(`${BASE}/app/settings`);
  await page.getByText("Intervalle de contrôle").waitFor();
  await shot(page, "10-settings");

  // 10. Cleanup (local): delete the instance from the registry.
  if (!READONLY) {
    await page.goto(`${instanceUrl}?tab=settings`);
    await page.getByTestId("delete-form").locator("button").click();
    await page.waitForURL(/\/app$/);
    if (await page.locator(`[data-testid="instance-card"][data-name="${INSTANCE}"]`).count()) fail("instance still listed after delete");
    log("instance deleted");
    console.log(`E2E_DB=${dbName}`);
  }

  // Optional: brute-force lockout (LOCKOUT=1). Locks this client IP for 15 min afterwards.
  if (process.env.LOCKOUT === "1") {
    const ctx2 = await browser.newContext({ ignoreHTTPSErrors: !!RESOLVE });
    const p2 = await ctx2.newPage();
    for (let i = 0; i < 5; i++) {
      await p2.goto(`${BASE}/login`);
      await p2.fill('input[name="username"]', ADMIN.user);
      await p2.fill('input[name="password"]', `wrong-${TAG}-${i}`);
      await p2.click('button[type="submit"]');
      await p2.getByText("Identifiants invalides").waitFor();
    }
    await p2.fill('input[name="username"]', ADMIN.user);
    await p2.fill('input[name="password"]', ADMIN.pass);
    await p2.click('button[type="submit"]');
    await p2.getByText("Identifiants invalides").waitFor();
    if (!/\/login/.test(p2.url())) fail("correct password accepted while locked out");
    log("lockout active: correct password refused after 5 failures");
    await ctx2.close();
  }

  // Unauthenticated API must be refused.
  const anon = await browser.newContext();
  const r = await anon.request.get(`${BASE}/api/alerts`, { maxRedirects: 0 });
  if (r.status() !== 307 && r.status() !== 302 && r.status() !== 401) fail(`anon /api/alerts ${r.status()}`);
  await anon.close();

  if (errors.length) log(`WARN page errors: ${errors.join(" | ")}`);
  await browser.close();
  log("ALL OK");
})().catch((err) => {
  console.error("[e2e] FAILED", err);
  process.exit(1);
});
