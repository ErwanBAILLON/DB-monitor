// Explorer tour: logs in, opens the Explorer tab of named instances, browses a table with a
// filter and a sort, opens Profil and Statistiques, screenshots each step.
//   BASE=https://dbmon.ebaillon.fr RESOLVE_IP=192.168.1.150 ADMIN_USERNAME=... ADMIN_PASSWORD=... \
//   INSTANCES="shared-postgres,dbmon-test-mariadb" PLAYWRIGHT=<path> SHOTS=/tmp/dbmon-explorer node scripts/e2e-explorer.cjs
// Optional per-instance picks: PICK_<name>=container/object/filterColumn/filterValue/sortColumn (defaults: first container, first table).
// Fails on any explore-error panel, page error, or empty grid.
const PW = process.env.PLAYWRIGHT || "playwright";
const { chromium } = require(PW);
const fs = require("fs");

const BASE = (process.env.BASE || "http://127.0.0.1:3180").replace(/\/$/, "");
const SHOTS = process.env.SHOTS || "/tmp/dbmon-explorer";
const ADMIN = { user: process.env.ADMIN_USERNAME || "admin", pass: process.env.ADMIN_PASSWORD || "localadmin123" };
const RESOLVE = process.env.RESOLVE_IP;
const NAMES = (process.env.INSTANCES || "").split(",").map((s) => s.trim()).filter(Boolean);
fs.mkdirSync(SHOTS, { recursive: true });
const log = (m) => console.log(`[explorer] ${m}`);

(async () => {
  const args = RESOLVE ? [`--host-resolver-rules=MAP ${new URL(BASE).hostname} ${RESOLVE}`] : [];
  const browser = await chromium.launch({ args });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "fr-FR", ignoreHTTPSErrors: !!RESOLVE });
  const page = await ctx.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));

  await page.goto(`${BASE}/login`);
  await page.fill('input[name="username"]', ADMIN.user);
  await page.fill('input[name="password"]', ADMIN.pass);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app$/);
  log("logged in");

  for (const name of NAMES) {
    await page.goto(`${BASE}/app`);
    await page.getByTestId("fleet-summary").waitFor();
    const card = page.locator(`[data-testid="instance-card"][data-name="${name}"]`);
    if ((await card.count()) === 0) {
      problems.push(`${name}: not registered`);
      continue;
    }
    await card.locator("a").first().click();
    await page.waitForURL(/\/app\/instances\/[^/?]+/);
    const url = page.url().replace(/\?.*$/, "");
    const pick = (process.env[`PICK_${name.replace(/[^A-Za-z0-9]/g, "_")}`] || "").split("/");
    await page.goto(`${url}?tab=explorer`);
    await page.getByTestId("explore-tree").waitFor();
    // Container
    const containerBtn = pick[0] ? page.getByTestId(`container-${pick[0]}`) : page.locator('[data-testid^="container-"]').first();
    await containerBtn.waitFor({ timeout: 30_000 });
    const container = (await containerBtn.getAttribute("data-testid")).replace(/^container-/, "");
    await containerBtn.click();
    await page.getByTestId("stats-panel").waitFor({ timeout: 30_000 }).catch(() => undefined);
    const objectBtn = pick[1] ? page.getByTestId(`object-${pick[1]}`) : page.locator('[data-testid^="object-"]').first();
    await objectBtn.waitFor({ timeout: 30_000 });
    const object = (await objectBtn.getAttribute("data-testid")).replace(/^object-/, "");
    await objectBtn.click();
    await page.getByTestId("structure-panel").waitFor({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/${name}-structure.png`, fullPage: true });
    log(`${name}: ${container}/${object} structure ok`);
    // Données: filter + sort
    await page.getByTestId("subtab-data").click();
    await page.getByTestId("data-grid").waitFor({ timeout: 30_000 });
    const headers = await page.locator('[data-testid="data-grid"] thead th[data-testid^="col-"]').allInnerTexts();
    const filterCol = pick[2] || headers[0];
    const sortCol = pick[4] || headers[Math.min(1, headers.length - 1)];
    await page.getByTestId("filter-column").selectOption(filterCol);
    await page.getByTestId("filter-op").selectOption(pick[3] !== undefined && pick[3] !== "" ? ">=" : "is not null");
    if (pick[3]) await page.getByTestId("filter-value").fill(pick[3]);
    await page.getByTestId("filter-add").click();
    await page.getByTestId("filter-chip").first().waitFor();
    await page.getByTestId(`col-${sortCol}`).click();
    await page.waitForFunction(() => /▲|▼/.test(document.querySelector('[data-testid="data-grid"] thead')?.textContent || ""));
    await page.waitForFunction(() => !/mise à jour/.test(document.querySelector('[data-testid="browse-summary"]')?.textContent || ""));
    const summary = await page.getByTestId("browse-summary").innerText();
    const rows = await page.locator('[data-testid="data-grid"] tbody tr').count();
    if (rows === 0) problems.push(`${name}: empty grid after filter`);
    // Drawer on first cell
    await page.locator('[data-testid="data-grid"] tbody tr td').nth(1).click();
    await page.getByTestId("cell-drawer").waitFor();
    await page.screenshot({ path: `${SHOTS}/${name}-drawer.png` });
    await page.keyboard.press("Escape");
    await page.getByTestId("cell-drawer").waitFor({ state: "detached" });
    await page.screenshot({ path: `${SHOTS}/${name}-data.png`, fullPage: true });
    log(`${name}: data ok (${rows} rows, ${summary.replace(/\s+/g, " ")}, filter ${filterCol}, sort ${sortCol})`);
    // Profil
    await page.getByTestId("subtab-profile").click();
    await page.getByTestId("profile-column").waitFor({ timeout: 30_000 });
    await page.getByTestId("profile-column").selectOption({ index: 1 });
    await page.waitForFunction(() => !!document.querySelector('[data-testid="profile-panel"] .card'), null, { timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}/${name}-profile.png`, fullPage: true });
    log(`${name}: profile ok`);
    // Statistiques tab
    await page.goto(`${url}?tab=stats`);
    await page.getByTestId("stats-panel").waitFor({ timeout: 60_000 });
    const sections = await page.locator('[data-testid^="stat-"]').count();
    await page.screenshot({ path: `${SHOTS}/${name}-stats.png`, fullPage: true });
    log(`${name}: stats ok (${sections} sections)`);
    const errs = await page.locator('[data-testid="explore-error"]').allInnerTexts();
    for (const e of errs) problems.push(`${name}: ${e}`);
  }
  await browser.close();
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  log(`done, screenshots in ${SHOTS}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
