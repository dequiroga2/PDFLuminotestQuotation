const express = require("express");
const fs = require("fs");
const path = require("path");
const puppeteer = require("puppeteer");
const { PDFDocument, StandardFonts } = require("pdf-lib");


const app = express();
app.use(express.json({ limit: "15mb" }));

const TEMPLATE_HTML = path.join(__dirname, "templates", "index.1.html");
const LOGO_SVG = path.join(__dirname, "templates", "luminotest-logo.svg");

// Ajusta aquí tus anexos (los que existan)
const ANNEXES = [
  path.join(__dirname, "templates", "anexo1.pdf"),
  path.join(__dirname, "templates", "anexo2.pdf"),
  path.join(__dirname, "templates", "anexo3.pdf"),
];

function todayDDMMYYYY() {
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(n, symbol = "$") {
  const v = Number(n || 0);
  return `${symbol} ${v.toLocaleString("es-CO", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDateTime(d = new Date()) {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${dd}/${mm}/${yyyy} ${hh}:${mi}:${ss}`;
}

async function stampFooterAllPages(pdfDoc, { generatedAtText, generatedByText }) {
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const size = 9;

  const pages = pdfDoc.getPages();
  const total = pages.length;

  for (let i = 0; i < total; i++) {
    const page = pages[i];
    const { width } = page.getSize();

    const leftX = 40;
    const y = 18;

    const leftText = generatedAtText;
    const centerText = generatedByText;
    const rightText = `Página ${i + 1} de ${total}`;

    // Left
    page.drawText(leftText, { x: leftX, y, size, font });

    // Center (centrado real)
    const centerW = font.widthOfTextAtSize(centerText, size);
    page.drawText(centerText, { x: (width / 2) - (centerW / 2), y, size, font });

    // Right (alineado a la derecha)
    const rightW = font.widthOfTextAtSize(rightText, size);
    page.drawText(rightText, { x: width - 40 - rightW, y, size, font });
  }
}


function asDataUriSvg(svgText) {
  const b64 = Buffer.from(svgText, "utf8").toString("base64");
  return `data:image/svg+xml;base64,${b64}`;
}

function buildRows(items, moneySymbol) {
  // items: [{ tecnologia, codigoEnsayo, ensayo, metodoEnsayo, acr, cantidad, valorUnitario }]
  return items.map((it, idx) => {
    const qty = Number(it.cantidad ?? it.quantity ?? 0);
    const unit = Number(it.valorUnitario ?? it.unitPrice ?? 0);
    const total = qty * unit;

    const acr = (it.acr === true || it.acr === "SI" || it.acr === "Si") ? "Si" : "No";

    return `
      <tr>
        <td class="center">${idx + 1}</td>
        <td>${escapeHtml(it.tecnologia ?? it.productName ?? "")}</td>
        <td>${escapeHtml(it.codigoEnsayo ?? it.essayCode ?? "")}</td>
        <td>${escapeHtml(it.ensayo ?? it.essayName ?? "")}</td>
        <td>${escapeHtml(it.metodoEnsayo ?? it.method ?? "")}</td>
        <td class="center">${acr}</td>
        <td class="center">${qty}</td>
        <td class="right">${money(unit, moneySymbol)}</td>
        <td class="right">${money(total, moneySymbol)}</td>
      </tr>
    `;
  }).join("\n");
}

function calcTotals(items, descuento, ivaRate) {
  const subtotal = items.reduce((s, it) => {
    const qty = Number(it.cantidad ?? it.quantity ?? 0);
    const unit = Number(it.valorUnitario ?? it.unitPrice ?? 0);
    return s + (qty * unit);
  }, 0);

  const disc = Number(descuento || 0);
  const base = Math.max(0, subtotal - disc);
  const iva = base * Number(ivaRate ?? 0.19);
  const total = base + iva;

  return { subtotal, disc, iva, total };
}

function safeAnnexes() {
  // solo anexos que existan
  return ANNEXES.filter(p => fs.existsSync(p));
}

const API_KEY = process.env.API_KEY;

function requireKey(req, res, next) {
  if (!API_KEY) return next(); // si no lo configuras, no bloquea
  const key = req.headers["x-api-key"];
  if (key !== API_KEY) return res.status(401).json({ ok:false, error:"Unauthorized" });
  next();
}


app.get("/health", (req, res) => res.json({ ok: true }));

app.post("/pdf/cotizacion", requireKey, async (req, res) => {
  try {
    const data = req.body || {};

    // Variables principales
    const cotNumber = String(data.cotNumber ?? data.cot ?? "").trim();
    const cotLabel = cotNumber.startsWith("COT-") ? cotNumber : `COT-${cotNumber}`;

    const organizacion = data.organizacion ?? data.organization ?? "";
    const firstname = data.firstname ?? data.firstName ?? "";
    const lastname = data.lastname ?? data.lastName ?? "";
    const email = data.email ?? "";
    const direccion = data.direccion ?? data.address ?? "";
    const telefono = data.telefono ?? data.phone ?? "";
    const ciudad = data.ciudad ?? data.city ?? "";

    const moneda = data.moneda ?? "USD";
    const moneySymbol = data.moneySymbol ?? "$";

    const descuento = data.descuento ?? 0;
    const ivaRate = data.ivaRate ?? 0.19;

    const acrInfo = data.acrInfo ?? "Aplica según el alcance del ensayo.";
    const observaciones = data.observaciones ?? "Ninguna.";
    const extraText = data.extraText ?? "";

    const items = Array.isArray(data.items) ? data.items : [];

    // Leer template + logo
    const htmlTemplate = fs.readFileSync(TEMPLATE_HTML, "utf8");
    const logoSvgText = fs.readFileSync(LOGO_SVG, "utf8");
    const logoDataUri = asDataUriSvg(logoSvgText);

    // Filas + totales
    const rowsHtml = buildRows(items, moneySymbol);
    const { subtotal, disc, iva, total } = calcTotals(items, descuento, ivaRate);

    const companyTop = data.companyTop ?? "LUMINOTEST S.A.S.";
    const docCode = data.docCode ?? "FO-COM-001 V21 2023/10/31";


    // Reemplazos
    let html = htmlTemplate
      .replaceAll("{{LOGO_DATA_URI}}", logoDataUri)
      .replaceAll("{{COT_LABEL}}", escapeHtml(cotLabel))
      .replaceAll("{{FECHA_HOY}}", escapeHtml(todayDDMMYYYY()))
      .replaceAll("{{ORGANIZACION}}", escapeHtml(organizacion))
      .replaceAll("{{FIRSTNAME}}", escapeHtml(firstname))
      .replaceAll("{{LASTNAME}}", escapeHtml(lastname))
      .replaceAll("{{EMAIL}}", escapeHtml(email))
      .replaceAll("{{DIRECCION}}", escapeHtml(direccion))
      .replaceAll("{{TELEFONO}}", escapeHtml(telefono))
      .replaceAll("{{CIUDAD}}", escapeHtml(ciudad))
      .replaceAll("{{TABLE_ROWS}}", rowsHtml || `<tr><td colspan="9" class="center">Sin ensayos</td></tr>`)
      .replaceAll("{{SUBTOTAL}}", money(subtotal, moneySymbol))
      .replaceAll("{{DESCUENTO}}", money(disc, moneySymbol))
      .replaceAll("{{IVA}}", money(iva, moneySymbol))
      .replaceAll("{{TOTAL}}", money(total, moneySymbol))
      .replaceAll("{{MONEDA}}", escapeHtml(moneda))
      .replaceAll("{{ACR_INFO}}", escapeHtml(acrInfo))
      .replaceAll("{{OBSERVACIONES}}", escapeHtml(observaciones))
      .replaceAll("{{EXTRA_TEXT}}", escapeHtml(extraText))
      .replaceAll("{{FOOTER_LEFT}}", escapeHtml(data.footerLeft ?? ""))
      .replaceAll("{{FOOTER_RIGHT}}", escapeHtml(data.footerRight ?? ""))
      .replaceAll("{{COMPANY_TOP}}", escapeHtml(companyTop))
      .replaceAll("{{DOC_CODE}}", escapeHtml(docCode));


    // Render PDF (Chrome paginará automáticamente si hay muchos ensayos)
    const browser = await puppeteer.launch({
      headless: "new",
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: "networkidle0" });

    const mainPdfBytes = await page.pdf({
      format: "Letter",
      printBackground: true,
      preferCSSPageSize: true,
    });

    await browser.close();

    // Merge con anexos
    const outDoc = await PDFDocument.create();

    const mainDoc = await PDFDocument.load(mainPdfBytes);
    const mainPages = await outDoc.copyPages(mainDoc, mainDoc.getPageIndices());
    mainPages.forEach(p => outDoc.addPage(p));

    for (const annexPath of safeAnnexes()) {
      const annexBytes = fs.readFileSync(annexPath);
      const annexDoc = await PDFDocument.load(annexBytes);
      const annexPages = await outDoc.copyPages(annexDoc, annexDoc.getPageIndices());
      annexPages.forEach(p => outDoc.addPage(p));
    }

    const generatedAtText = formatDateTime(new Date());
    const generatedByText = "Generado por LUMINOTEST S.A.S.";

    await stampFooterAllPages(outDoc, {
        generatedAtText,
        generatedByText
    });


    const finalBytes = await outDoc.save();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `inline; filename="${cotLabel}.pdf"`);
    res.status(200).send(Buffer.from(finalBytes));

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`PDF server listo en http://localhost:${PORT}`));
