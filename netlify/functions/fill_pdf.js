import { promises as fs } from "fs";
import path from "path";
import { PDFDocument } from "pdf-lib";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: { ...CORS_HEADERS, "Content-Type": "text/plain" },
    body: String(message),
    isBase64Encoded: false,
  };
}

function unwrapFirst(resp) {
  if (resp && typeof resp === "object" && !Array.isArray(resp)) {
    for (const key of ["objects", "data", "result", "elements"]) {
      if (resp[key] && resp[key].length) {
        return Array.isArray(resp[key]) ? resp[key][0] : resp[key];
      }
    }
    return resp;
  }
  if (Array.isArray(resp) && resp.length) return resp[0];
  return null;
}

async function fetchJSON(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: token,
      Accept: "application/json",
      "User-Agent": "pdf-filler/1.0",
    },
  });
  if (!res.ok) throw new Error(`Fetch failed ${res.status} ${url}`);
  return res.json();
}

async function fetchOrderAndContact(orderNumber, token) {
  const embed = "embed=positions";
  const urls = [
    `https://api.sevdesk.de/api/v1/Order?orderNumber=${orderNumber}&${embed}`,
    `https://api.sevdesk.de/api/v1/Order?number=${orderNumber}&${embed}`,
    `https://api.sevdesk.de/api/v1/Order/${orderNumber}?${embed}`,
    `https://my.sevdesk.de/api/v1/Order?orderNumber=${orderNumber}&${embed}`,
    `https://my.sevdesk.de/api/v1/Order/${orderNumber}?${embed}`,
  ];
  let order = null;
  for (const url of urls) {
    try {
      const resp = await fetchJSON(url, token);
      order = unwrapFirst(resp);
      if (order) break;
    } catch {
      continue;
    }
  }
  if (!order) throw new Error("Order not found");

  let contact = null;
  if (order && typeof order === "object") {
    for (const key of ["contact", "customer", "accountContact"]) {
      if (order[key]) {
        contact = order[key];
        break;
      }
    }
    if (!contact) {
      for (const key of ["contactId", "contact_id", "customerId"]) {
        if (order[key]) {
          contact = { id: order[key] };
          break;
        }
      }
    }
  }
  if (!contact) throw new Error("Contact not found in order");

  if (contact && contact.id && !contact.name && !contact.street) {
    const cid = contact.id;
    const contactUrls = [
      `https://api.sevdesk.de/api/v1/Contact/${cid}`,
      `https://my.sevdesk.de/api/v1/Contact/${cid}`,
    ];
    for (const cu of contactUrls) {
      try {
        const resp = await fetchJSON(cu, token);
        const c = unwrapFirst(resp);
        if (c) {
          contact = c;
          break;
        }
      } catch {
        continue;
      }
    }
  }

  return { order, contact };
}

function orderContactToMapping(order, contact) {
  const mapping = {};
  const parseAddressBlock = (block) => {
    if (!block) return [null, null];
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const street = lines[1] || null;
    const zipcity = lines[2] || lines[1] || null;
    return [street, zipcity];
  };

  let name =
    contact?.name || contact?.displayName || contact?.fullName || null;
  if (!name) {
    const parts = ["surename", "surname", "familyname"]
      .map((k) => contact?.[k])
      .filter(Boolean);
    name = parts.join(" ").trim();
  }
  if (!name) name = order?.addressName;
  if (!name && order?.address) name = order.address.split(/\r?\n/)[0]?.trim();
  if (name) mapping["Text1"] = name;

  let street = contact?.street || contact?.address;
  let zipc = contact?.zip || contact?.postalCode;
  let city = contact?.city || contact?.town;
  if ((!street || !(zipc || city)) && order?.address) {
    const [st2, zc2] = parseAddressBlock(order.address);
    street = street || st2;
    if (zc2 && !zipc && !city) {
      const parts = zc2.split(" ");
      zipc = parts[0] || zipc;
      city = parts.slice(1).join(" ") || city;
    }
  }
  if (street) mapping["Text2"] = street;
  if (zipc || city) mapping["Text3"] = [zipc, city].filter(Boolean).join(" ").trim();

  const email = contact?.email || contact?.mail;
  const phone = contact?.phone || contact?.telephone;
  if (email || phone) mapping["Text6"] = [phone, email].filter(Boolean).join(" / ");

  return mapping;
}

async function fetchOrderPositions(order, token, orderNumber) {
  if (order?.positions || order?.orderPositions) {
    return order.positions || order.orderPositions || [];
  }
  const orderId = order?.id;
  if (!orderId) return [];
  const params = new URLSearchParams();
  params.set("order[objectName]", "Order");
  params.set("order[id]", orderId);
  if (orderNumber) params.set("order[orderNumber]", orderNumber);

  const endpoints = [
    `https://api.sevdesk.de/api/v1/Order/${orderId}/positions`,
    `https://api.sevdesk.de/api/v1/OrderPos?order[id]=${orderId}`,
    `https://api.sevdesk.de/api/v1/OrderPos?orderId=${orderId}`,
    `https://api.sevdesk.de/api/v1/OrderPos?${params.toString()}`,
    `https://my.sevdesk.de/api/v1/Order/${orderId}/positions`,
    `https://my.sevdesk.de/api/v1/OrderPos?order[id]=${orderId}`,
    `https://my.sevdesk.de/api/v1/OrderPos?orderId=${orderId}`,
    `https://my.sevdesk.de/api/v1/OrderPos?${params.toString()}`,
  ];
  for (const url of endpoints) {
    try {
      const resp = await fetchJSON(url, token);
      const val = unwrapFirst(resp);
      if (Array.isArray(resp?.objects)) return resp.objects;
      if (Array.isArray(resp)) return resp;
      if (Array.isArray(val)) return val;
      if (val) return [val];
    } catch {
      continue;
    }
  }
  return [];
}

async function fetchPart(partId, token) {
  if (!partId) return null;
  const urls = [
    `https://api.sevdesk.de/api/v1/Part/${partId}?embed=category`,
    `https://my.sevdesk.de/api/v1/Part/${partId}?embed=category`,
  ];
  for (const url of urls) {
    try {
      const resp = await fetchJSON(url, token);
      const val = unwrapFirst(resp);
      if (val) return val;
    } catch {
      continue;
    }
  }
  return null;
}

function extractKwpFromPositions(positions) {
  if (!positions) return null;
  for (const pos of positions) {
    const name = pos?.name || pos?.title || pos?.text || "";
    if (typeof name !== "string") continue;
    if (!name.toLowerCase().startsWith("photovoltaikanlage")) continue;
    const m = name.match(/([0-9]+(?:[.,][0-9]+)?)\s*kWp/i);
    if (m) {
      const num = parseFloat(m[1].replace(",", "."));
      if (!isNaN(num)) return num.toFixed(1);
    }
  }
  return null;
}

function extractKwpFromOrder(order) {
  for (const key of ["header", "addressName", "address"]) {
    const txt = order?.[key];
    if (typeof txt !== "string") continue;
    const m = txt.match(/([0-9]+(?:[.,][0-9]+)?)\s*kWp/i);
    if (m) {
      const num = parseFloat(m[1].replace(",", "."));
      if (!isNaN(num)) return num.toFixed(1);
    }
  }
  return null;
}

async function extractInverterPower(positions, token) {
  if (!positions) return null;
  const keywords = ["wechselrichter", "inverter", "wr", "hybrid", "sungrow", "solax", "sma", "fronius", "huawei", "kostal"];
  let best = { name: null, power: null };
  const parsePower = (txt) => {
    if (typeof txt !== "string") return null;
    const m = txt.match(/([0-9]+(?:[.,][0-9]+)?)/);
    if (!m) return null;
    const num = parseFloat(m[1].replace(",", "."));
    return isNaN(num) ? null : num;
  };
  for (const pos of positions) {
    let candidates = [];
    if (typeof pos?.name === "string") candidates.push(pos.name);
    if (pos?.part?.id && token) {
      const part = await fetchPart(pos.part.id, token);
      if (part?.name) candidates.push(part.name);
      const catName = part?.category?.name;
      if (catName) candidates.push(catName);
    }
    for (const cand of candidates) {
      const low = cand.toLowerCase();
      if (!keywords.some((k) => low.includes(k))) continue;
      const power = parsePower(cand);
      if (power !== null && (best.power === null || power > best.power)) {
        best = { name: cand, power };
      }
    }
  }
  return best.power !== null ? best.power.toFixed(1) : null;
}

function appendDates(mapping) {
  const today = new Date();
  const fmt = today.toLocaleDateString("de-DE");
  ["Text40", "Text7"].forEach((key) => {
    const base = mapping[key] || "";
    const sep = base === "" || base.endsWith(" ") || base.endsWith(",") ? "" : " ";
    mapping[key] = `${base}${sep}${fmt}`;
  });
}

async function fillPdf(mapping) {
  const formPath = process.env.FORM_PATH || path.join(process.cwd(), "Fertigmeldung_Ihrer_Anlage Vorlage.pdf");
  const pdfBytes = await fs.readFile(formPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);
  const form = pdfDoc.getForm();
  Object.entries(mapping).forEach(([key, val]) => {
    if (val === undefined || val === null) return;
    let field;
    try {
      field = form.getField(key);
    } catch {
      return;
    }
    if (field.setText) {
      field.setText(String(val));
    } else if (field.check && typeof val === "string" && val.toLowerCase() === "/ja") {
      field.check();
    } else if (field.check && val) {
      field.check();
    }
  });
  const out = await pdfDoc.save();
  return out;
}

function buildFilename(mapping) {
  const name = mapping["Text1"];
  if (typeof name !== "string") return "filled.pdf";
  const parts = name.trim().split(/\s+/);
  if (!parts.length) return "filled.pdf";
  const last = parts[parts.length - 1].replace(/[^A-Za-z0-9_-]+/g, "");
  return last ? `Fertigmeldung_Ihrer_Anlage_${last}_Vorlage.pdf` : "filled.pdf";
}

export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS };
  }
  try {
    const apiKey = process.env.API_KEY;
    const auth = event.headers?.authorization || event.headers?.Authorization;
    if (apiKey && auth !== apiKey) {
      return errorResponse(401, "Unauthorized");
    }
    const body = event.body ? JSON.parse(event.body) : {};
    const orderNumber = body.orderNumber || process.env.SEVDESK_DEFAULT_ORDER;
    const token = body.token || process.env.SEVDESK_FIXED_TOKEN;
    if (!orderNumber || !token) {
      return errorResponse(400, "orderNumber and token required");
    }

    let mapping = {};
    try {
      const tmplPath = path.join(process.cwd(), "fields_template.json");
      mapping = JSON.parse(await fs.readFile(tmplPath, "utf-8"));
    } catch {
      mapping = {};
    }

    const { order, contact } = await fetchOrderAndContact(orderNumber, token);
    Object.assign(mapping, orderContactToMapping(order, contact));

    const positions = await fetchOrderPositions(order, token, orderNumber);
    const kwp = extractKwpFromPositions(positions) || extractKwpFromOrder(order);
    if (kwp) mapping["kWp"] = kwp;
    const inverterPower = await extractInverterPower(positions, token);
    if (inverterPower) {
      mapping["kW"] = inverterPower;
      mapping["kVA"] = inverterPower;
    }

    appendDates(mapping);

    const pdfOut = await fillPdf(mapping);
    const filename = buildFilename(mapping);
    return {
      statusCode: 200,
      headers: {
        ...CORS_HEADERS,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
      body: Buffer.from(pdfOut).toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    return errorResponse(500, `Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
