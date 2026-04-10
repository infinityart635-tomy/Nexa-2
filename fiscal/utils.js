function tipoCmpFromDocType(docType) {
  const map = {
    FACTURA_A: 1,
    FACTURA_B: 6,
    FACTURA_C: 11,
  };
  const key = String(docType || "").toUpperCase();
  return map[key] || 0;
}

function tipoDocFromReceiver(docType) {
  const value = String(docType || "").toUpperCase();
  if (value === "CUIT") return 80;
  if (value === "CUIL") return 86;
  if (value === "CDI") return 87;
  if (value === "DNI") return 96;
  return 99;
}

function buildArcaQrUrl(doc) {
  try {
    if (!doc || !doc.cae) return "";
    const cuit = Number(String((doc.company && doc.company.cuit) || "").replace(/\D/g, ""));
    const ptoVta = Number(String(doc.pos || "0").replace(/\D/g, ""));
    const tipoCmp = tipoCmpFromDocType(doc.docType);
    const nroCmp = Number(doc.number || 0);
    const importe = Number(doc.total || 0);
    const tipoDocRec = tipoDocFromReceiver(doc.receiverDocType);
    const nroDocRec = Number(String(doc.receiverDocNumber || "").replace(/\D/g, "")) || 0;

    const payload = {
      ver: 1,
      fecha: String(doc.issueDate || "").slice(0, 10),
      cuit,
      ptoVta,
      tipoCmp,
      nroCmp,
      importe,
      moneda: "PES",
      ctz: 1,
      tipoDocRec,
      nroDocRec,
      tipoCodAut: "E",
      codAut: Number(String(doc.cae || "").replace(/\D/g, "")) || 0,
    };

    const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
    return "https://www.arca.gob.ar/fe/qr/?p=" + encodeURIComponent(b64);
  } catch (e) {
    return "";
  }
}

module.exports = {
  tipoCmpFromDocType,
  tipoDocFromReceiver,
  buildArcaQrUrl,
};
