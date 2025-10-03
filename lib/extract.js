// lib/extract.js
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// No importamos 'canvas' ni DOMMatrix

let pdfjs = null;
async function ensurePdfjs() {
  if (!pdfjs) {
    // Build apta para Node
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjs;
}

async function extractTextFromPdfBuffer(uint8) {
  const _pdfjs = await ensurePdfjs();

  // Desactivar worker y otras features de browser
  const loadingTask = _pdfjs.getDocument({
    data: uint8,
    disableWorker: true,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false,
  });

  const pdf = await loadingTask.promise;

  let fullText = "";
  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const content = await page.getTextContent();
    const strings = content.items.map((it) => it.str);
    fullText += strings.join(" ") + "\n";
  }
  return fullText.replace(/\r/g, "").trim();
}

export async function extractMainTextFromUrl(url) {
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*" },
  });
  if (!res.ok) throw new Error(`No se pudo descargar la URL: ${res.status}`);

  const contentType = (res.headers.get("content-type") || "").toLowerCase();

  // --- PDF ---
  if (contentType.includes("application/pdf") || url.toLowerCase().endsWith(".pdf")) {
    const arrayBuffer = await res.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuffer);
    const rawText = await extractTextFromPdfBuffer(uint8);
    if (!rawText) throw new Error("No se pudo extraer texto del PDF.");
    const title = url.split("/").pop() || "Documento PDF";
    return { title, text: rawText };
  }

  // --- HTML ---
  const html = await res.text();
  const dom = new JSDOM(html, { url });
  const reader = new Readability(dom.window.document);
  const article = reader.parse();
  if (!article || !article.textContent || !article.textContent.trim()) {
    throw new Error("No se pudo extraer contenido legible de la página HTML.");
  }
  return {
    title: article.title || (url.split("/").pop() || "Documento"),
    text: article.textContent.trim(),
  };
}

export async function extractMany(urls) {
  const results = [];
  for (const u of urls) {
    try {
      const r = await extractMainTextFromUrl(u);
      results.push(r);
    } catch (e) {
      console.error("Error extrayendo", u, e.message);
    }
  }
  const title = results.map((r) => r.title).join(" + ");
  const text = results.map((r) => r.text).join("\n\n");
  if (!text.trim()) throw new Error("No se pudo extraer texto de las fuentes.");
  return { title, text };
}
