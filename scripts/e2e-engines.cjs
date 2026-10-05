// Engine tour: registers (or reuses) instances and walks through every detail tab.
//   BASE=http://127.0.0.1:3170 ADMIN_PASSWORD=... ENGINES_FILE=/path/engines.json node scripts/e2e-engines.cjs
//   engines.json: [{ name, type, host, port, username, password, database, query, queryDb, tls }]
// Prod: BASE=https://dbmon.ebaillon.fr RESOLVE_IP=192.168.1.150 (instances must already be allowed by DBMON_ALLOWED_TARGETS).
// Fails on any "engine-error" panel, page error, or console query error. Screenshots in SHOTS.
const PW = process.env.PLAYWRIGHT || "playwright";
const { chromium } = require(PW);
const fs = require("fs");

const BASE = (process.env.BASE || "http://127.0.0.1:3170").replace(/\/$/, "");
const SHOTS = process.env.SHOTS || "/tmp/dbmon-engines";
const ADMIN = { user: process.env.ADMIN_USERNAME || "admin", pass: process.env.ADMIN_PASSWORD || "localadmin123" };
const RESOLVE = process.env.RESOLVE_IP;
const specs = JSON.parse(fs.readFileSync(process.env.ENGINES_FILE, "utf8"));
fs.mkdirSync(SHOTS, { recursive: true });
const log = (m) => console.log(`[tour] ${m}`);

(async () => {
  const args = RESOLVE ? [`--host-resolver-rules=MAP ${new URL(BASE).hostname} ${RESOLVE}`] : [];
  const browser = await chromium.launch({ args });
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, locale: "fr-FR", ignoreHTTPSErrors: !!RESOLVE });
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto(`${BASE}/login`);
  await page.fill('input[name="username"]', ADMIN.user);
  await page.fill('input[name="password"]', ADMIN.pass);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app$/);
  log("logged in");

  for (const s of specs) {
    // Reuse by name when already registered.
    await page.goto(`${BASE}/app`);
    await page.getByTestId("fleet-summary").waitFor();
    let card = page.locator(`[data-testid="instance-card"][data-name="${s.name}"]`);
    if ((await card.count()) === 0) {
      await page.goto(`${BASE}/app/instances/new`);
      await page.selectOption('select[name="type"]', s.type);
      await page.fill('input[name="name"]', s.name);
      await page.fill('input[name="host"]', s.host);
      await page.fill('input[name="port"]', String(s.port));
      if (s.username) await page.fill('input[name="username"]', s.username);
      if (s.password) await page.fill('input[name="password"]', s.password);
      if (s.database) await page.fill('input[name="database"]', s.database);
      await page.fill('input[name="environment"]', s.environment || "test");
      await page.fill('input[name="tags"]', s.tags || "dbmon-test");
      if (s.tls) await page.check('input[name="tls"]');
      await page.click('[data-testid="instance-form"] button[type="submit"]');
      await page.waitForURL(/\/app\/instances\/(?!new$)[^/?]+$/, { timeout: 30_000 });
      log(`${s.name}: created`);
    } else {
      await card.locator("a").first().click();
      await page.waitForURL(/\/app\/instances\/[^/?]+/);
    }
    const url = page.url().replace(/\?.*$/, "");
    await page.getByTestId("last-state").waitFor({ timeout: 20_000 });
    const state = await page.getByTestId("last-state").innerText();
    log(`${s.name}: overview -> ${state}`);
    if (!state.startsWith("up")) problems.push(`${s.name}: not up (${state})`);
    await page.screenshot({ path: `${SHOTS}/${s.name}-overview.png`, fullPage: true });

    const tabs = await page.locator('[data-testid^="tab-"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid").slice(4)));
    for (const tab of tabs.filter((t) => !["overview", "settings"].includes(t))) {
      const t0 = Date.now();
      await page.goto(`${url}?tab=${tab}`, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch((e) => problems.push(`${s.name}/${tab}: goto ${e.message.split("\n")[0]}`));
      log(`${s.name}/${tab}: loaded in ${Date.now() - t0} ms`);
      const ok = await page
        .getByTestId("instance-name")
        .waitFor({ timeout: 60_000 })
        .then(() => true)
        .catch(() => false);
      if (!ok) {
        problems.push(`${s.name}/${tab}: page did not render: ${(await page.locator("body").innerText().catch(() => "?")).slice(0, 300)}`);
        continue;
      }
      const err = page.getByTestId("engine-error");
      if ((await err.count()) > 0) problems.push(`${s.name}/${tab}: ${await err.innerText()}`);
      if (tab === "query" && s.query) {
        if (s.queryDb) await page.selectOption('select[name="database"]', s.queryDb);
        await page.fill('textarea[name="sql"]', s.query);
        await page.click('form button[type="submit"]:has-text("Exécuter")');
        await Promise.race([page.getByTestId("query-result").waitFor({ timeout: 20_000 }), page.getByTestId("query-error").waitFor({ timeout: 20_000 })]);
        if ((await page.getByTestId("query-error").count()) > 0) problems.push(`${s.name}/query: ${await page.getByTestId("query-error").innerText()}`);
        else log(`${s.name}/query: ${await page.getByTestId("query-result").locator("p").first().innerText()}`);
      }
      await page.screenshot({ path: `${SHOTS}/${s.name}-${tab}.png`, fullPage: true });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) log(`WARN overflow ${overflow}px on ${s.name}/${tab}`);
    }
    log(`${s.name}: ${tabs.length} tabs visited`);
  }
  await page.goto(`${BASE}/app`);
  await page.getByTestId("fleet-summary").waitFor();
  await page.screenshot({ path: `${SHOTS}/fleet.png`, fullPage: true });
  await browser.close();
  if (problems.length) {
    console.error("[tour] PROBLEMS:\n - " + problems.join("\n - "));
    process.exit(1);
  }
  log("OK");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
