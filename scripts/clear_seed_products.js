const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { createPostgresStorage } = require("../postgres_storage");

const ROOT = path.resolve(__dirname, "..");
const DATA_FILE = path.join(ROOT, "data", "db.json");

function now() {
  return Date.now();
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function readFileRoot() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
}

function writeFileRoot(root) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(root, null, 2) + "\n", "utf8");
}

function clearProducts(root) {
  const report = [];
  const restaurantData = root && root.restaurantData && typeof root.restaurantData === "object"
    ? root.restaurantData
    : {};

  for (const [restaurantId, workspace] of Object.entries(restaurantData)) {
    if (!workspace || typeof workspace !== "object") continue;
    const products = Array.isArray(workspace.products) ? workspace.products : [];
    const sales = Array.isArray(workspace.sales) ? workspace.sales : [];
    const tickets = Array.isArray(workspace.tickets) ? workspace.tickets : [];
    const hasActivity = sales.length > 0 || tickets.length > 0;
    if (hasActivity || products.length === 0) {
      report.push({
        restaurantId,
        skipped: true,
        reason: hasActivity ? "has_activity" : "no_products",
        productsBefore: products.length,
      });
      continue;
    }
    workspace.products = [];
    workspace.updatedAt = now();
    report.push({
      restaurantId,
      skipped: false,
      productsBefore: products.length,
      productsAfter: 0,
    });
  }

  root.updatedAt = now();
  return report;
}

async function main() {
  const usePostgres = !!String(process.env.DATABASE_URL || "").trim();
  if (usePostgres) {
    const storage = createPostgresStorage();
    await storage.init();
    try {
      const root = await storage.getDocument("root_db");
      if (!root) throw new Error("No existe root_db en Postgres.");
      const nextRoot = clone(root);
      const report = clearProducts(nextRoot);
      await storage.saveDocument("root_db", nextRoot);
      console.table(report);
      return;
    } finally {
      await storage.close();
    }
  }

  const root = readFileRoot();
  const report = clearProducts(root);
  writeFileRoot(root);
  console.table(report);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
