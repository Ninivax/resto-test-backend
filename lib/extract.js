// lib/extract.js
import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// ---------------------------------------------------------------------------
// Utilidades: timeout, reintentos, normalización de URLs de descarga
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function withTimeout(promise, ms, abortController) {
  const t = setTimeout(() => abortController.abort(), ms);
  return promise.finally(() => clearTimeout(t));
}

function normalizeDownloadUrl(url) {
  try {
    const u = new URL(url);

    // Google Drive: .../file/d/ID/view  ->  https://drive.google.com/uc?export=download&id=ID
    if (u.hostname.includes("drive.google.com")) {
      const m = u.pathname.match(/\/file\/d\/([^/]+)\//);
      if (m && m[1]) {
        return `https://drive.google.com/uc?export=download&id=${m[1]}`;
      }
      // share links tipo open?id=... -> forzamos descarga
      if (u.searchParams.get("id")) {
        return `https://drive.google.com/uc?export=download&id=${u.searchParams.get("id")}`;
      }
    }

    // OneDrive (share links): añade ?download=1 si no está
    if (u.hostname.endsWith("1drv.ms") || u.hostname.includes("sharepoint.com") || u.hostname.includes("onedrive.live.com")) {
      if (!u.searchParams.has("download")) {
        u.searchParams.set("download", "1");
        return u.toString();
      }
    }

    return url;
  } catch {
    return url;
  }
}

async function fetchWithRetry(url, { tries = 3, timeoutMs = 20000 } = {}) {
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
    "Accept": "*/*",
    "Accept-Language": "es-ES,es;q=0.9"
  };

  let lastErr;
  const finalUrl = normalizeDownloadUrl(url);

  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    try {
      const res = await withTimeout(
        fetch(finalUrl, {
          method: "GET",
          redirect: "follow",     // sigue 3xx
          headers,
          signal: ac.signal
        }),
        timeoutMs,
        ac
      );

      // Reintenta en 5xx; 4xx no suele mejorar con reintentos
      if (res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status} ${res.statusText}`);
        await sleep(500 * (i + 1));
        continue;
      }

      // OK o 3xx (node-fetch ya siguió) → devolvemos
      return res;
    } catch (e) {
      lastErr = e.name === "AbortError"
        ? new Error(`Timeout tras ${timeoutMs} ms`)
        : e;
      await sleep(500 * (i + 1));
    }
  }
  const msg = lastErr?.message || String(lastErr);
  throw new Error(`No se pudo descargar la URL (${finalUrl}): ${msg}`);
}

// ---------------------------------------------------------------------------
// PDF.js (build legacy para Node)
// ---------------------------------------------------------------------------
let pdfjs = null;
async function ensurePdfjs() {
  if (!pdfjs) {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  }
  return pdfjs;
}

async function extractTextFromPdfBuffer(uint8) {
  const _pdfjs = await ensurePdfjs();

  const loadingTask = _pdfjs.getDocument({
    data: uint8,
    disableWorker: true,
    disableFontFace: true,
    isEvalSupported: false,
    useWorkerFetch: false
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

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------
export async function extractMainTextFromUrl(url) {
  const res = await fetchWithRetry(url, { tries: 3, timeoutMs: 20000 });

  if (!res.ok) {
    throw new Error(`No se pudo descargar la URL: ${res.status}`);
  }

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
  const errors = [];

  for (const u of urls) {
    try {
      const r = await extractMainTextFromUrl(u);
      results.push(r);
    } catch (e) {
      console.error("Error extrayendo", u, e.message);
      errors.push({ url: u, error: e.message });
    }
  }

  const title = results.map((r) => r.title).join(" + ");
  const text = results.map((r) => r.text).join("\n\n");

  if (!text.trim()) {
    // Propaga el primer error si lo hay, útil para tu handler de respuesta
    const detail = errors[0]?.error || "No se pudo extraer texto de las fuentes.";
    const err = new Error("No se pudo extraer texto de las fuentes.");
    err.detail = detail;
    throw err;
  }

  return { title, text, errors };
}

