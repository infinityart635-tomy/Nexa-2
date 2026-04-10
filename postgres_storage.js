const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const DOCUMENT_KEYS = {
  menu: "menu",
  rootDb: "root_db",
};

function truthy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "require";
}

function falsy(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off" || normalized === "disable" || normalized === "disabled";
}

function buildPgSslConfig(connectionString) {
  if (falsy(process.env.DATABASE_SSL)) return false;
  if (truthy(process.env.DATABASE_SSL)) return { rejectUnauthorized: false };

  const envMode = String(process.env.PGSSLMODE || "").trim().toLowerCase();
  if (envMode === "disable") return false;
  if (envMode && envMode !== "allow" && envMode !== "prefer") {
    return { rejectUnauthorized: false };
  }

  try {
    const parsed = new URL(connectionString);
    const mode = String(parsed.searchParams.get("sslmode") || "").trim().toLowerCase();
    if (mode === "disable") return false;
    if (mode && mode !== "allow" && mode !== "prefer") {
      return { rejectUnauthorized: false };
    }
  } catch {}

  return false;
}

function normalizeBlobKey(key) {
  return String(key || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/\.\./g, "");
}

function blobUrlToKey(url) {
  const raw = String(url || "").trim();
  if (!raw.startsWith("/images/")) return "";
  return normalizeBlobKey(raw.slice(1));
}

function contentTypeForFile(file) {
  const ext = path.extname(String(file || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

function mimeToExtension(mimeType) {
  const mime = String(mimeType || "").trim().toLowerCase();
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  if (mime === "application/pdf") return "pdf";
  if (mime === "image/svg+xml") return "svg";
  return "";
}

function parseDataUrl(dataUrl) {
  const raw = String(dataUrl || "").trim();
  if (!raw.startsWith("data:")) return null;
  const splitIdx = raw.indexOf("base64,");
  if (splitIdx === -1) return null;
  const head = raw.slice(5, splitIdx - 1);
  const mimeType = String(head.split(";")[0] || "").trim().toLowerCase();
  const base64 = raw.slice(splitIdx + 7).replace(/\s+/g, "");
  let buffer;
  try {
    buffer = Buffer.from(base64, "base64");
  } catch {
    return null;
  }
  if (!buffer || !buffer.length) return null;
  return { mimeType, buffer };
}

function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listFilesRecursive(rootDir) {
  if (!rootDir || !fs.existsSync(rootDir)) return [];
  const out = [];
  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile()) {
        out.push(abs);
      }
    }
  }
  return out.sort();
}

function createPostgresStorage(options = {}) {
  const connectionString = String(options.connectionString || process.env.DATABASE_URL || "").trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL no definido");
  }

  const pool = new Pool({
    connectionString,
    ssl: buildPgSslConfig(connectionString),
    max: Math.max(1, Number(process.env.PGPOOL_MAX || 5) || 5),
  });

  return {
    mode: "postgres",
    documentKeys: DOCUMENT_KEYS,
    async init() {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_documents (
          id TEXT PRIMARY KEY,
          value JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`
        CREATE TABLE IF NOT EXISTS app_blobs (
          key TEXT PRIMARY KEY,
          mime_type TEXT NOT NULL,
          data BYTEA NOT NULL,
          is_private BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    },
    async hasDocument(id) {
      const result = await pool.query("SELECT 1 FROM app_documents WHERE id = $1", [String(id || "")]);
      return result.rowCount > 0;
    },
    async getDocument(id) {
      const result = await pool.query("SELECT value FROM app_documents WHERE id = $1", [String(id || "")]);
      return result.rowCount ? result.rows[0].value : null;
    },
    async saveDocument(id, value) {
      await pool.query(
        `
          INSERT INTO app_documents (id, value, updated_at)
          VALUES ($1, $2::jsonb, NOW())
          ON CONFLICT (id)
          DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `,
        [String(id || ""), JSON.stringify(value ?? null)]
      );
    },
    async hasBlob(key) {
      const result = await pool.query("SELECT 1 FROM app_blobs WHERE key = $1", [normalizeBlobKey(key)]);
      return result.rowCount > 0;
    },
    async getBlob(key) {
      const result = await pool.query(
        "SELECT key, mime_type, data, is_private FROM app_blobs WHERE key = $1",
        [normalizeBlobKey(key)]
      );
      if (!result.rowCount) return null;
      return {
        key: result.rows[0].key,
        mimeType: result.rows[0].mime_type,
        data: result.rows[0].data,
        isPrivate: !!result.rows[0].is_private,
      };
    },
    async saveBlob(key, mimeType, data, options = {}) {
      await pool.query(
        `
          INSERT INTO app_blobs (key, mime_type, data, is_private, updated_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (key)
          DO UPDATE SET mime_type = EXCLUDED.mime_type, data = EXCLUDED.data, is_private = EXCLUDED.is_private, updated_at = NOW()
        `,
        [normalizeBlobKey(key), String(mimeType || "application/octet-stream"), data, !!options.isPrivate]
      );
    },
    async deleteBlob(key) {
      await pool.query("DELETE FROM app_blobs WHERE key = $1", [normalizeBlobKey(key)]);
    },
    async close() {
      await pool.end();
    },
  };
}

async function seedPostgresFromDisk(storage, options = {}) {
  const report = {
    documents: [],
    blobsImported: 0,
  };
  if (!storage || storage.mode !== "postgres") return report;

  const overwrite = !!options.overwrite;
  const menuFile = options.menuFile || "";
  const dbFile = options.dbFile || "";
  const imagesDir = options.imagesDir || "";

  const menu = readJsonIfExists(menuFile);
  if (menu !== null && (overwrite || !(await storage.hasDocument(DOCUMENT_KEYS.menu)))) {
    await storage.saveDocument(DOCUMENT_KEYS.menu, menu);
    report.documents.push(DOCUMENT_KEYS.menu);
  }

  const rootDb = readJsonIfExists(dbFile);
  if (rootDb !== null && (overwrite || !(await storage.hasDocument(DOCUMENT_KEYS.rootDb)))) {
    await storage.saveDocument(DOCUMENT_KEYS.rootDb, rootDb);
    report.documents.push(DOCUMENT_KEYS.rootDb);
  }

  const files = listFilesRecursive(imagesDir);
  for (const file of files) {
    const relative = path.relative(imagesDir, file).split(path.sep).join("/");
    const key = normalizeBlobKey(path.posix.join("images", relative));
    if (!overwrite && (await storage.hasBlob(key))) continue;
    await storage.saveBlob(key, contentTypeForFile(file), fs.readFileSync(file), {
      isPrivate: key.startsWith("images/fiscal/"),
    });
    report.blobsImported += 1;
  }

  return report;
}

module.exports = {
  blobUrlToKey,
  createPostgresStorage,
  mimeToExtension,
  parseDataUrl,
  seedPostgresFromDisk,
};
