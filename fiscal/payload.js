function safeString(value, fallback = "") {
  return String(value || fallback).trim();
}

function safeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeItems(ticket, sale) {
  const source = Array.isArray(ticket && ticket.items) ? ticket.items
    : Array.isArray(sale && sale.items) ? sale.items
    : [];
  return source.map(item => ({
    lineId: item.lineId || item.productId || "",
    productId: item.productId || "",
    name: safeString(item.name),
    qty: safeNumber(item.qty),
    unitPrice: safeNumber(item.unitPrice || item.basePrice),
    total: safeNumber(item.qty) * safeNumber(item.unitPrice || item.basePrice),
    sectorId: safeString(item.sectorId),
  }));
}

function buildDocument(doc) {
  return {
    id: doc.id,
    saleId: doc.saleId,
    ticketId: doc.ticketId,
    docType: safeString(doc.docType),
    pos: safeString(doc.pos),
    number: safeNumber(doc.number),
    fiscalType: safeString(doc.fiscalType),
    total: safeNumber(doc.total),
    currency: safeString(doc.currency),
    issueDate: safeString(doc.issueDate),
    status: safeString(doc.status),
    cae: safeString(doc.cae),
    caeDue: safeString(doc.caeDue),
    observations: Array.isArray(doc.observations) ? doc.observations.map(v => safeString(v)) : [],
  };
}

function buildReceiver(doc) {
  return {
    docType: safeString(doc.receiverDocType),
    docNumber: safeString(doc.receiverDocNumber),
    name: safeString(doc.receiverName),
    iva: safeString(doc.receiverIva),
  };
}

function buildCompany(doc) {
  return {
    razonSocial: safeString(doc.company && doc.company.razonSocial),
    cuit: safeString(doc.company && doc.company.cuit),
    domicilio: safeString(doc.company && doc.company.domicilio),
    ivaCondicion: safeString(doc.company && doc.company.ivaCondicion),
    iibb: safeString(doc.company && doc.company.iibb),
    inicioActividades: safeString(doc.company && doc.company.inicioActividades),
  };
}

function buildSaleInfo(sale) {
  if (!sale) return null;
  return {
    id: sale.id,
    paymentMethod: safeString(sale.paymentMethod),
    total: safeNumber(sale.total),
    subtotal: safeNumber(sale.subtotal),
    discountAmount: safeNumber(sale.discountAmount),
    fiscalType: safeString(sale.fiscalType),
  };
}

function buildTicketInfo(ticket) {
  if (!ticket) return null;
  return {
    id: ticket.id,
    customerName: safeString(ticket.customerName),
    customerAddress: safeString(ticket.customerAddress),
    customerPhone: safeString(ticket.customerPhone),
    channel: safeString(ticket.channel),
    tableId: safeString(ticket.tableId),
  };
}

function buildFiscalDocPayload(doc, sale, ticket) {
  return {
    document: buildDocument(doc),
    receiver: buildReceiver(doc),
    company: buildCompany(doc),
    sale: buildSaleInfo(sale),
    ticket: buildTicketInfo(ticket),
    items: normalizeItems(ticket, sale),
  };
}

function padNumber(value, size = 8) {
  return String(value || "").padStart(size, "0");
}

function formatCurrency(value, currency = "ARS") {
  const n = safeNumber(value);
  return `${n.toFixed(2)} ${currency}`;
}

function formatFiscalDocText(payload) {
  const doc = payload.document || {};
  const rec = payload.receiver || {};
  const comp = payload.company || {};
  const sale = payload.sale || {};
  const ticket = payload.ticket || {};
  const lines = [];
  lines.push(`Comprobante: ${doc.docType || "N/A"} ${padNumber(doc.pos, 4)}-${padNumber(doc.number, 8)}`);
  lines.push(`Fecha: ${doc.issueDate || "N/A"} · Estado: ${doc.status || "pendiente"}`);
  lines.push(`Total: ${formatCurrency(doc.total, doc.currency)}`);
  if (doc.observations && doc.observations.length) {
    lines.push(`Observaciones: ${doc.observations.join(" | ")}`);
  }
  if (comp.razonSocial) {
    lines.push(`Emisor: ${comp.razonSocial} · CUIT ${comp.cuit} · IVA ${comp.ivaCondicion}`);
  }
  lines.push(`Receptor: ${rec.docType || "Consumidor final"} ${rec.docNumber || ""} · ${rec.name || "-"}`);
  if (rec.iva) lines.push(`IVA receptor: ${rec.iva}`);
  if (sale.paymentMethod) lines.push(`Forma de pago: ${sale.paymentMethod}`);
  if (ticket.channel) lines.push(`Canal: ${ticket.channel} · Mesa: ${ticket.tableId || "-"}`);
  const items = Array.isArray(payload.items) ? payload.items : [];
  if (items.length) {
    lines.push("Items:");
    items.forEach(item => {
      const unit = formatCurrency(item.unitPrice);
      const total = formatCurrency(item.total);
      lines.push(`  • ${item.qty} x ${item.name || "Ítem"} @ ${unit} = ${total}`);
    });
  }
  return lines.join("\n");
}

module.exports = {
  buildFiscalDocPayload,
  formatFiscalDocText,
};
