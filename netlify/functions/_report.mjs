// Builds the "Tariff Exposure Report" PDF as raw bytes (Uint8Array),
// ready to upload to Supabase Storage. Kept deliberately simple for the
// MVP: a title page plus one row per watched HS code — no charts, no
// branding yet (white-label branding is a later, paid-tier feature).
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const PAGE_SIZE = [612, 792]; // US Letter, points
const MARGIN = 50;
const ROW_HEIGHT = 18;

export async function buildExposureReportPdf({ watchlistName, generatedAt, items }) {
  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage(PAGE_SIZE);
  let y = PAGE_SIZE[1] - MARGIN;

  const drawText = (text, { size = 10, bold = false, color = rgb(0, 0, 0) } = {}) => {
    page.drawText(text, { x: MARGIN, y, size, font: bold ? boldFont : font, color });
  };

  drawText("Tariff Watch — Tariff Exposure Report", { size: 18, bold: true });
  y -= 28;
  drawText(`Watchlist: ${watchlistName || "My Watchlist"}`, { size: 11 });
  y -= 16;
  drawText(`Generated: ${generatedAt}`, { size: 11, color: rgb(0.4, 0.4, 0.4) });
  y -= 30;

  if (items.length === 0) {
    drawText("No tracked HS codes were found on this watchlist.", { size: 11 });
  } else {
    drawText("HS code", { size: 10, bold: true });
    page.drawText("Description", { x: MARGIN + 90, y, size: 10, font: boldFont });
    page.drawText("Rate", { x: MARGIN + 340, y, size: 10, font: boldFont });
    page.drawText("Effective", { x: MARGIN + 400, y, size: 10, font: boldFont });
    y -= ROW_HEIGHT;
    page.drawLine({
      start: { x: MARGIN, y: y + 12 },
      end: { x: PAGE_SIZE[0] - MARGIN, y: y + 12 },
      thickness: 0.5,
      color: rgb(0.7, 0.7, 0.7),
    });

    for (const item of items) {
      if (y < MARGIN + ROW_HEIGHT) {
        page = pdfDoc.addPage(PAGE_SIZE);
        y = PAGE_SIZE[1] - MARGIN;
      }
      const desc = (item.desc || "").slice(0, 48);
      page.drawText(item.hs || item.id, { x: MARGIN, y, size: 9, font });
      page.drawText(desc, { x: MARGIN + 90, y, size: 9, font });
      page.drawText(`${item.rate ?? "—"}%`, { x: MARGIN + 340, y, size: 9, font });
      page.drawText(item.effectiveDate || "—", { x: MARGIN + 400, y, size: 9, font });
      y -= ROW_HEIGHT;
    }
  }

  return pdfDoc.save();
}
