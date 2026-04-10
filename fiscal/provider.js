const createArcaProvider = require("./providers/arca");

const ARCA_PROVIDERS = new Set(["arca", "wsfev1"]);

function getFiscalProvider(settings = {}) {
  const provider = String(settings.provider || "manual").toLowerCase();
  if (ARCA_PROVIDERS.has(provider)) {
    return createArcaProvider(settings);
  }
  return null;
}

module.exports = {
  getFiscalProvider,
};
