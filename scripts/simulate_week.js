const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

const SERVER_URL = process.env.NEXA_URL || "ws://localhost:3000";
const DB_PATH = path.join(__dirname, "..", "data", "db.json");

function loadSessionToken() {
  const raw = fs.readFileSync(DB_PATH, "utf8");
  const db = JSON.parse(raw);
  const now = Date.now();
  const sessions = Array.isArray(db.sessions) ? db.sessions : [];
  const pick = (role) => sessions.find(s => s && s.role === role && (!s.expiresAt || s.expiresAt > now));
  const ses = pick("admin") || pick("mozo");
  if (!ses) throw new Error("No hay sesiones activas. Inicia sesion y reintenta.");
  return { token: ses.token, role: ses.role, name: ses.name || "" };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function ymdFromDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function run() {
  const ses = loadSessionToken();
  const ws = new WebSocket(SERVER_URL, {
    headers: { Cookie: `nexa_token=${ses.token}` },
  });

  let db = null;
  let lastNotify = [];
  const actionQueue = [];

  function log(msg) {
    process.stdout.write(msg + "\n");
  }

  function sendAction(kind, payload = {}) {
    return new Promise((resolve, reject) => {
      actionQueue.push({ resolve, reject, kind });
      ws.send(JSON.stringify({ type: "action", kind, payload }));
    });
  }

  function waitForState(timeoutMs = 3000) {
    const start = Date.now();
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (db) return resolve(db);
        if (Date.now() - start > timeoutMs) return reject(new Error("Sin estado inicial."));
        setTimeout(tick, 50);
      };
      tick();
    });
  }

  function getActiveProducts(d, count = 5) {
    return (d.products || []).filter(p => p && p.active !== false).slice(0, count);
  }

  function getTableIds(d, count = 4) {
    return (d.tables || []).map(t => t.id).slice(0, count);
  }

  function getTicketByTable(tableId) {
    if (!db) return null;
    const table = (db.tables || []).find(t => t.id === tableId);
    if (!table || !table.ticketId) return null;
    return (db.tickets || []).find(t => t.id === table.ticketId && t.status === "abierta") || null;
  }

  function getTicketById(id) {
    if (!db) return null;
    return (db.tickets || []).find(t => t.id === id && t.status === "abierta") || null;
  }

  function assert(cond, msg) {
    if (!cond) log(`!! ${msg}`);
  }

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "state") db = msg.db;
    if (msg.type === "notify") lastNotify.push(msg);
    if (msg.type === "action:ok") {
      const next = actionQueue.shift();
      if (next) next.resolve(msg);
    }
    if (msg.type === "action:error") {
      const next = actionQueue.shift();
      if (next) next.reject(new Error(msg.error || "action:error"));
    }
  });

  await new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.send(JSON.stringify({ type: "hello", name: ses.name || "SimAdmin" }));
  await waitForState();

  log(`Conectado como ${ses.role}.`);

  const baseDate = new Date();
  const tables = getTableIds(db, 6);
  const products = getActiveProducts(db, 6);
  assert(tables.length >= 2, "No hay suficientes mesas para simular.");
  assert(products.length >= 2, "No hay suficientes productos activos.");

  const simProductId = "SIM-CAFE";
  const simIngredientName = "SIM Ingrediente Cafe";
  const simSupplierName = "SIM Proveedor";

  // Admin setup (producto + ingrediente + proveedor)
  await sendAction("products:upsert", {
    productId: simProductId,
    name: "Cafe SIM",
    price: 1200,
    categoryTitle: "SIM",
    active: true
  });
  await sendAction("products:setSector", { productId: simProductId, sectorId: "barra" });
  await sendAction("products:setModifiers", {
    productId: simProductId,
    modifiers: [
      {
        id: "size",
        name: "Tamano",
        mode: "single",
        required: true,
        options: [
          { id: "chico", name: "Chico", price: 0, default: true },
          { id: "grande", name: "Grande", price: 300 }
        ]
      }
    ]
  });

  await sendAction("inventory:addIngredient", {
    name: simIngredientName,
    unit: "u",
    onHand: 50,
    costPerUnit: 150
  });
  await sleep(150);
  const ingredient = (db.inventory && db.inventory.ingredients || []).find(i => i.name === simIngredientName);
  if (ingredient) {
    await sendAction("inventory:setRecipe", {
      productId: simProductId,
      recipe: [{ ingredientId: ingredient.id, qty: 1 }]
    });
  }

  await sendAction("people:addSupplier", { name: simSupplierName, phone: "11 2222 3333" });
  await sleep(150);
  const supplier = (db.people && db.people.suppliers || []).find(s => s.name === simSupplierName);
  if (supplier && ingredient) {
    await sendAction("purchases:create", {
      supplierId: supplier.id,
      items: [{ ingredientId: ingredient.id, qty: 10, unitCost: 120 }],
      note: "Compra SIM"
    });
    await sendAction("accounts:supplierPayment", {
      supplierId: supplier.id,
      amount: 500,
      note: "Pago SIM"
    });
  }

  for (let i = 0; i < 7; i++) {
    const dateKey = ymdFromDate(new Date(baseDate.getTime() + i * 86400000));
    log(`\n--- Dia ${i + 1} (${dateKey}) ---`);

    await sendAction("cash:turnOpen", { dateKey, shift: "dia", cashier: "SIM", openingDenoms: { b1000: 2 } });
    await sendAction("attendance:checkIn", { name: `SimMozo${i + 1}` });

    // Mesa principal
    const tableId = tables[i % tables.length];
    await sendAction("ticket:ensureForTable", { tableId });
    await sleep(120);
    let ticket = getTicketByTable(tableId);
    assert(ticket, `No se genero ticket en ${tableId}`);

    // Agregar items (uno con modificador)
    if (ticket) {
      await sendAction("ticket:addItemEx", {
        ticketId: ticket.id,
        productId: simProductId,
        qty: 1,
        selections: { size: ["grande"] }
      });
      await sendAction("ticket:addItemEx", {
        ticketId: ticket.id,
        productId: products[0].id,
        qty: 2,
        selections: {}
      });
      await sendAction("ticket:setMeta", { ticketId: ticket.id, notes: "Sin hielo" });
    }

    await sleep(150);
    ticket = getTicketByTable(tableId);
    if (ticket && ticket.items && ticket.items[0]) {
      await sendAction("ticket:setDiscount", { ticketId: ticket.id, discount: { type: "percent", value: 10 } });
      const lineId = ticket.items[0].lineId;
      if (lineId) {
        await sendAction("ticket:setLineDiscount", { ticketId: ticket.id, lineId, discount: { type: "amount", value: 100 } });
      }
    }

    // Enviar a cocina y avanzar estados
    if (ticket) {
      await sendAction("ticket:sendToKitchen", { ticketId: ticket.id });
      await sendAction("ticket:setKitchenStatus", { ticketId: ticket.id, status: "en_preparacion", scope: "pending" });
      await sendAction("ticket:setKitchenStatus", { ticketId: ticket.id, status: "listo", scope: "pending" });
      await sendAction("ticket:setKitchenStatus", { ticketId: ticket.id, status: "entregado", scope: "ready" });
    }

    // Sumar producto despues de listo (dias pares)
    if (i % 2 === 1 && ticket) {
      await sendAction("ticket:addItemEx", {
        ticketId: ticket.id,
        productId: products[1].id,
        qty: 1,
        selections: {}
      });
      await sendAction("ticket:sendToKitchen", { ticketId: ticket.id });
      await sendAction("ticket:setKitchenStatus", { ticketId: ticket.id, status: "listo", scope: "pending" });
      await sendAction("ticket:setKitchenStatus", { ticketId: ticket.id, status: "entregado", scope: "ready" });
    }

    // Mover mesa (dia 3)
    if (i === 2 && ticket && tables.length > 1) {
      const toTable = tables[(i + 1) % tables.length];
      await sendAction("ticket:moveTable", { ticketId: ticket.id, toTableId: toTable });
    }

    // Cerrar ticket (cobro)
    if (ticket) {
      await sendAction("ticket:close", { ticketId: ticket.id, paymentMethod: "efectivo", fiscalType: "no_fiscal" });
    }

    // Ticket cancelado (dia 4)
    if (i === 3) {
      const cancelTable = tables[(i + 2) % tables.length];
      await sendAction("ticket:ensureForTable", { tableId: cancelTable });
      await sleep(120);
      const cancelTicket = getTicketByTable(cancelTable);
      if (cancelTicket) {
        await sendAction("ticket:addItemEx", { ticketId: cancelTicket.id, productId: products[2].id, qty: 1, selections: {} });
        await sendAction("ticket:cancel", { ticketId: cancelTicket.id, reason: "Cliente se fue" });
      }
    }

    // Ticket mostrador y delivery (dia 5)
    if (i === 4) {
      await sendAction("ticket:create", { channel: "mostrador" });
      await sleep(120);
      const mostrador = (db.tickets || []).find(t => t.channel === "mostrador" && t.status === "abierta");
      if (mostrador) {
        await sendAction("ticket:addItemEx", { ticketId: mostrador.id, productId: products[0].id, qty: 1, selections: {} });
        await sendAction("ticket:close", { ticketId: mostrador.id, paymentMethod: "efectivo", fiscalType: "no_fiscal" });
      }

      await sendAction("ticket:create", { channel: "delivery" });
      await sleep(120);
      const delivery = (db.tickets || []).find(t => t.channel === "delivery" && t.status === "abierta");
      if (delivery) {
        await sendAction("ticket:setMeta", { ticketId: delivery.id, customerName: "SIM Cliente", customerPhone: "11 4444 5555", customerAddress: "SIM 123" });
        await sendAction("ticket:addItemEx", { ticketId: delivery.id, productId: products[1].id, qty: 2, selections: {} });
        await sendAction("ticket:close", { ticketId: delivery.id, paymentMethod: "transferencia", fiscalType: "no_fiscal" });
      }
    }

    await sendAction("attendance:checkOut", { name: `SimMozo${i + 1}` });
    await sendAction("cash:turnClose", { dateKey, closingDenoms: { b1000: 1 }, note: "Cierre SIM" });
    await sendAction("cash:close", { closingCash: 1000, note: "Cierre caja SIM" });

    await sleep(150);
  }

  // Resumen de notificaciones con warning
  const warns = lastNotify.filter(n => n.kind === "warn");
  if (warns.length) {
    log("\nAvisos WARN:");
    warns.slice(0, 20).forEach(n => log(`- ${n.text}`));
  } else {
    log("\nSin notificaciones WARN.");
  }

  ws.close();
}

run().catch(err => {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
});
