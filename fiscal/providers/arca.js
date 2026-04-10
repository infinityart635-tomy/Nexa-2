const https = require("https");

const DEFAULT_ENDPOINTS = {
  homologacion: "https://wsfehomo.arca.gob.ar/fe/wsfev1",
  produccion: "https://www.arca.gob.ar/fe/wsfev1",
};

const { buildFiscalDocPayload } = require("../payload");

const DEFAULT_TIMEOUT_MS = 15000;

function normalizeConfig(raw) {
  const cfg = raw && typeof raw === "object" ? raw : {};
  const parseNumber = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    endpoint: String(cfg.endpoint || "").trim(),
    endpointHomologacion: String(cfg.endpointHomologacion || "").trim(),
    endpointProduccion: String(cfg.endpointProduccion || "").trim(),
    timeoutMs: parseNumber(cfg.timeoutMs || cfg.timeout, DEFAULT_TIMEOUT_MS),
    certificatePem: cfg.certificatePem ? String(cfg.certificatePem) : "",
    privateKeyPem: cfg.privateKeyPem ? String(cfg.privateKeyPem) : "",
    pfxBase64: cfg.pfxBase64 ? String(cfg.pfxBase64) : "",
    passphrase: cfg.passphrase ? String(cfg.passphrase) : "",
    bearerToken: String(cfg.bearerToken || "").trim(),
    rejectUnauthorized: cfg.rejectUnauthorized === false ? false : true,
  };
}

function buildAgent(config) {
  const haveCert = !!config.certificatePem;
  const haveKey = !!config.privateKeyPem;
  const havePfx = !!config.pfxBase64;
  if (!haveCert && !haveKey && !havePfx) return null;
  const opts = { rejectUnauthorized: config.rejectUnauthorized !== false };
  if (havePfx) {
    try {
      opts.pfx = Buffer.from(config.pfxBase64, "base64");
    } catch (err) {
      throw new Error("PFX base64 inválido");
    }
  } else {
    if (haveCert) opts.cert = config.certificatePem;
    if (haveKey) opts.key = config.privateKeyPem;
  }
  if (config.passphrase) opts.passphrase = config.passphrase;
  return new https.Agent(opts);
}

function resolveEndpoint(env, config) {
  const key = env === "produccion" ? "produccion" : "homologacion";
  const fallback = config.endpoint || DEFAULT_ENDPOINTS[key];
  if (key === "produccion") {
    return config.endpointProduccion || fallback;
  }
  return config.endpointHomologacion || fallback;
}

function truncate(value, max = 240) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.length > max ? text.slice(0, max) + "..." : text;
}

function firstNonEmpty(...items) {
  for (const item of items) {
    const value = String(item || "").trim();
    if (value) return value;
  }
  return "";
}

function parseResponse(text) {
  const parsed = tryParseJson(text);
  const observations = [];
  if (parsed) {
    if (Array.isArray(parsed.observaciones)) {
      parsed.observaciones.forEach(item => {
        const msg = String(item || "").trim();
        if (msg) observations.push(msg);
      });
    }
    if (parsed.mensaje) observations.push(String(parsed.mensaje).trim());
    if (parsed.message) observations.push(String(parsed.message).trim());
    if (Array.isArray(parsed.errors)) {
      parsed.errors.forEach(item => {
        const msg = String(item || "").trim();
        if (msg) observations.push(msg);
      });
    }
    if (parsed.error) observations.push(String(parsed.error).trim());
  }
  if (!observations.length && text) {
    observations.push(truncate(text, 200));
  }
  const cae = firstNonEmpty(
    parsed && parsed.cae,
    parsed && parsed.codAut,
    findXmlTag(text, ["CAE", "codAut", "codigo"])
  );
  const caeDue = firstNonEmpty(
    parsed && parsed.caeDue,
    parsed && parsed.fechaVto,
    findXmlTag(text, ["vtoCAE", "fechaVto", "vto", "fecha_vto"])
  );
  const message = firstNonEmpty(
    parsed && parsed.statusMessage,
    parsed && parsed.message,
    parsed && parsed.mensaje,
    observations[0]
  );
  return {
    status: parsed && parsed.status ? String(parsed.status).trim() : "",
    cae,
    caeDue,
    observations,
    message,
    raw: truncate(text, 400),
  };
}

function tryParseJson(value) {
  if (!value || typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function findXmlTag(text, tags) {
  if (!text) return "";
  for (const tag of tags || []) {
    const name = String(tag || "").trim();
    if (!name) continue;
    const regex = new RegExp(`<${name}[^>]*>([^<]+)</${name}>`, "i");
    const match = regex.exec(text);
    if (match) return match[1].trim();
  }
  return "";
}

function createArcaProvider(settings = {}) {
  const config = normalizeConfig(settings.providerConfig || {});
  config.agent = buildAgent(config);

  return {
    emitFiscalDoc: async ({ doc, sale, ticket }) => {
      if (!doc) throw new Error("Documento fiscal inválido");
      const env = (String(doc.environment || settings.environment || "homologacion").toLowerCase() === "produccion") ? "produccion" : "homologacion";
      const endpoint = resolveEndpoint(env, config);
      if (!endpoint) throw new Error("Endpoint ARCA no configurado");
      const fetchFn = globalThis.fetch;
      if (typeof fetchFn !== "function") throw new Error("fetch no disponible en este entorno");
      const controller = new AbortController();
      const timeout = Number.isFinite(config.timeoutMs) ? config.timeoutMs : DEFAULT_TIMEOUT_MS;
      const timer = setTimeout(() => controller.abort(), timeout);
      try {
        const headers = {
          "Content-Type": "application/json",
          Accept: "application/json,text/plain,application/xml,*/*",
        };
        if (config.bearerToken) {
          headers.Authorization = "Bearer " + config.bearerToken;
        }
        const body = buildFiscalDocPayload(doc, sale || {}, ticket || {});
        const requestOptions = {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        };
        if (config.agent) {
          requestOptions.agent = () => config.agent;
        }
        const response = await fetchFn(endpoint, requestOptions);
        const text = await response.text();
        const parsed = parseResponse(text);
        const providerResponse = {
          statusCode: response.status,
          body: parsed.message || parsed.raw,
        };
        return {
          status: parsed.status || (response.ok ? "emitido" : "rechazado"),
          cae: parsed.cae,
          caeDue: parsed.caeDue,
          observations: parsed.observations,
          providerResponse,
        };
      } catch (err) {
        if (err && err.name === "AbortError") {
          throw new Error("Tiempo de espera agotado en la emisión fiscal");
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

module.exports = createArcaProvider;
