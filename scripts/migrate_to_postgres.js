require("dotenv").config({ quiet: true });

const path = require("path");
const { createPostgresStorage, seedPostgresFromDisk } = require("../postgres_storage");

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const storage = createPostgresStorage();

  await storage.init();

  const report = await seedPostgresFromDisk(storage, {
    menuFile: path.join(projectRoot, "data", "menu.json"),
    dbFile: path.join(projectRoot, "data", "db.json"),
    imagesDir: path.join(projectRoot, "data", "images"),
    overwrite: process.argv.includes("--overwrite"),
  });

  console.log("Migracion finalizada.");
  console.log(`Documentos cargados: ${report.documents.length ? report.documents.join(", ") : "ninguno"}`);
  console.log(`Blobs cargados: ${report.blobsImported}`);

  await storage.close();
}

main().catch(async (error) => {
  console.error("Fallo la migracion a PostgreSQL:", error && error.message ? error.message : error);
  process.exitCode = 1;
});
