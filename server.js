import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { extractMainTextFromUrl } from "./lib/extract.js";
import { generateQuestionBank } from "./lib/generate.js";

const app = express();
const NUM_QUESTIONS = Number(process.env.NUM_QUESTIONS || 10);
const WEBHOOK_URL = (process.env.WEBHOOK_URL || "").trim();

// --- CORS + JSON ---
app.use(
  cors({
    origin: true,
    credentials: false,
  })
);
app.use(express.json({ limit: "2mb" }));

// --- URLs fijas (tus 3 manuales) ---
const SOURCES = {
  procedimiento:
    "https://966e7448.delivery.rocketcdn.me/wp-content/uploads/manuales/pez-vela/GT2025-RRHH-PezVela-Manual-de-procedimiento.pdf",
  maridaje:
    "https://966e7448.delivery.rocketcdn.me/wp-content/uploads/manuales/pez-vela/GT2025-RRHH-PezVela-maridaje.pdf",
  recetario:
    "https://966e7448.delivery.rocketcdn.me/wp-content/uploads/manuales/pez-vela/GT2025-RRHH-PezVela-recetario.pdf",
};

// 💾 Intentos en memoria (en prod: BD/Redis)
const attempts = new Map();

// --- Helpers ---
const toLetter = (i) => String.fromCharCode(65 + i);
function letterToIndex(letter) {
  const L = String(letter || "").trim().toUpperCase();
  return { A: 0, B: 1, C: 2, D: 3 }[L] ?? -1;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// Reparto equitativo por fuente, resto → procedimiento, luego maridaje, luego recetario
function allocateCounts(total) {
  const base = Math.floor(total / 3);
  let remainder = total % 3;
  const order = ["procedimiento", "maridaje", "recetario"];
  const out = { procedimiento: base, maridaje: base, recetario: base };
  for (const k of order) {
    if (remainder <= 0) break;
    out[k]++;
    remainder--;
  }
  return out;
}

// --- Normalización para quitar “A) ”, “1.”, etc. del prompt y las opciones ---
const LEADING_LABEL_RE = /^\s*(?:([A-Da-d])|([1-4]))[\)\.\-:]\s+|\s*^[A-Da-d]\)\s+|\s*^\d+\)\s+/;
function stripLeadingLabel(str = "") {
  let s = String(str).trim();
  // elimina patrones comunes A) / a) / 1) / 1. / 1- :
  s = s.replace(/^\s*([A-Da-d]|[1-4])[\)\.\-:]\s+/, "");
  // si el modelo repite doble prefijo raro, limpiar otra vez
  s = s.replace(/^\s*([A-Da-d]|[1-4])[\)\.\-:]\s+/, "");
  return s.trim();
}
function normalizeQuestion(q) {
  const opts = Array.isArray(q.options) ? q.options : [];
  const cleanOpts = opts.map((o) => stripLeadingLabel(o));
  return {
    ...q,
    prompt: stripLeadingLabel(q.prompt || ""),
    options: cleanOpts,
  };
}

// --- fetch fallback (por si el runtime no trae global.fetch) ---
async function getFetch() {
  if (typeof fetch === "function") return fetch;
  const nf = (await import("node-fetch")).default;
  return nf;
}

// Helper POST JSON (para Make) con logs
async function postJSON(url, body, timeoutMs = 12000) {
  const f = await getFetch();
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);

  let res, text;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    text = await res.text().catch(() => "");
  } catch (err) {
    clearTimeout(t);
    const msg = err?.message || String(err);
    console.error("[webhook] network error:", msg);
    return { ok: false, status: 0, text: msg };
  }

  clearTimeout(t);
  return { ok: res.ok, status: res.status, text };
}

// --- Salud ---
app.get("/health", (req, res) =>
  res.json({ ok: true, numQuestions: NUM_QUESTIONS })
);

// --- START ---
app.post("/api/start-test", async (req, res) => {
  const t0 = Date.now();
  try {
    const { dni, candidateName, startCommand, source = "all" } = req.body || {};

    // Validaciones
    if (!candidateName || String(candidateName).trim().length < 3) {
      return res.status(400).json({ error: "Nombre y apellidos inválidos" });
    }
    if (!dni || !/^[A-Za-z0-9\-]{5,}$/.test(String(dni).trim())) {
      return res.status(400).json({ error: "DNI inválido" });
    }
    if (startCommand !== "Realizar Test") {
      return res
        .status(400)
        .json({ error: "Debes escribir exactamente: Realizar Test" });
    }

    // Si piden una sola fuente, generamos solo de esa
    if (["procedimiento", "maridaje", "recetario"].includes(source)) {
      const url = SOURCES[source];
      console.log("[start-test] fuente única:", source, url);

      // 1) Extraer texto
      let title, text;
      try {
        const out = await extractMainTextFromUrl(url);
        title = out.title;
        text = out.text;
        console.log(
          "[start-test] extracción OK · chars:",
          (text && text.length) || 0
        );
        if (!text || text.trim().length < 200) {
          throw new Error("Texto extraído insuficiente (menos de 200 caracteres)");
        }
      } catch (e) {
        console.error("[start-test] ERROR extrayendo texto:", e);
        return res.status(500).json({
          error: "Fallo al extraer texto de la fuente",
          detail: String(e?.message || e),
        });
      }

      // 2) Generar preguntas con IA (usará NUM_QUESTIONS)
      let bank;
      try {
        bank = await generateQuestionBank({ text, role: "" }); // devuelve NUM_QUESTIONS
      } catch (e) {
        console.error("[start-test] ERROR generando preguntas:", e);
        return res.status(500).json({
          error: "Fallo al generar preguntas con IA",
          detail: String(e?.message || e),
        });
      }

      // Normalizar, etiquetar con la fuente y garantizar IDs únicos
      const tagged = bank.map((q) => ({
        ...normalizeQuestion(q),
        id: `${source}__${q.id}`,
        source,
      }));

      // Guardar intento
      const attemptId = crypto.randomUUID();
      attempts.set(attemptId, {
        dni,
        candidateName,
        urls: [url],
        title,
        startedAt: new Date().toISOString(),
        questions: tagged,
        answers: [],
      });

      console.log(
        `[start-test] OK (single source) · attemptId=${attemptId} · ${Date.now() - t0}ms`
      );

      return res.json({
        attemptId,
        sourceTitle: title,
        numQuestions: tagged.length,
        questions: tagged.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          options: q.options,
        })),
      });
    }

    // Caso por defecto: 3 fuentes, reparto equitativo
    const counts = allocateCounts(NUM_QUESTIONS); // {procedimiento:x, maridaje:y, recetario:z}
    console.log("[start-test] reparto por fuente:", counts);

    // 1) Extraer cada PDF por separado
    let titles = {};
    let texts = {};
    try {
      for (const key of Object.keys(SOURCES)) {
        const { title, text } = await extractMainTextFromUrl(SOURCES[key]);
        titles[key] = title;
        texts[key] = text;
        console.log(`[start-test] ${key} extracción OK · chars:`, (text && text.length) || 0);
        if (!text || !String(text).trim() || String(text).trim().length < 200) {
          throw new Error(`Texto extraído insuficiente en ${key} (menos de 200 caracteres)`);
        }
      }
    } catch (e) {
      console.error("[start-test] ERROR extrayendo textos:", e);
      return res.status(500).json({
        error: "Fallo al extraer texto de las fuentes",
        detail: String(e?.message || e),
      });
    }

    // 2) Generar banco por cada fuente
    let banks = {};
    try {
      for (const key of Object.keys(SOURCES)) {
        const bank = await generateQuestionBank({ text: texts[key], role: "" }); // devuelve NUM_QUESTIONS
        // Normalizar cada pregunta del banco
        banks[key] = bank.map((q) => normalizeQuestion(q));
        console.log(`[start-test] generación OK en ${key} · tamaño banco:`, bank?.length);
      }
    } catch (e) {
      console.error("[start-test] ERROR generando preguntas:", e);
      return res.status(500).json({
        error: "Fallo al generar preguntas con IA",
        detail: String(e?.message || e),
      });
    }

    // 3) Seleccionar por fuente según counts, etiquetar y combinar
    const selectedBySource = {};
    for (const key of Object.keys(banks)) {
      const need = counts[key];
      const fromBank = shuffle(banks[key]).slice(0, need).map((q) => ({
        ...q,
        id: `${key}__${q.id}`, // prefijo para unicidad
        source: key,
      }));
      selectedBySource[key] = fromBank;
    }

    let combined = [
      ...selectedBySource.procedimiento,
      ...selectedBySource.maridaje,
      ...selectedBySource.recetario,
    ];
    combined = shuffle(combined);

    // 4) Guardar intento
    const attemptId = crypto.randomUUID();
    attempts.set(attemptId, {
      dni,
      candidateName,
      urls: Object.values(SOURCES),
      title: `Procedimiento / Maridaje / Recetario`,
      startedAt: new Date().toISOString(),
      questions: combined, // [{ id, prompt, options, correctIndex, source }]
      answers: [],
    });

    console.log(
      `[start-test] OK · attemptId=${attemptId} · total preguntas=${combined.length} · ${Date.now() - t0}ms`
    );

    // 5) Respuesta (sin correctas)
    return res.json({
      attemptId,
      sourceTitle: "Pez Vela – Manuales (3 fuentes)",
      numQuestions: combined.length,
      questions: combined.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        options: q.options,
      })),
    });
  } catch (err) {
    console.error("[start-test] ERROR inesperado:", err);
    return res.status(500).json({
      error: "No se pudo iniciar el test",
      detail: String(err?.message || err),
    });
  }
});

// --- ANSWER ---
app.post("/api/answer", (req, res) => {
  try {
    const { attemptId, questionId, choice } = req.body || {};
    const attempt = attempts.get(attemptId);
    if (!attempt) return res.status(404).json({ error: "Intento no encontrado" });

    const q = attempt.questions.find((x) => x.id === questionId);
    if (!q) return res.status(400).json({ error: "Pregunta inválida" });

    const idx = letterToIndex(choice);
    if (idx < 0) return res.status(400).json({ error: "Responde con A, B, C o D." });

    // Evitar duplicados
    const already = attempt.answers.find((a) => a.questionId === questionId);
    if (!already) {
      attempt.answers.push({
        questionId,
        choiceIndex: idx,
        choiceLetter: toLetter(idx),
      });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("[answer] ERROR:", err);
    return res.status(500).json({ error: "Fallo al registrar la respuesta", detail: String(err?.message || err) });
  }
});

// --- FINISH ---
app.post("/api/finish", async (req, res) => {
  try {
    const { attemptId } = req.body || {};
    const attempt = attempts.get(attemptId);
    if (!attempt) return res.status(404).json({ error: "Intento no encontrado" });

    if (attempt.answers.length !== attempt.questions.length) {
      return res.status(400).json({ error: "Aún faltan preguntas por responder" });
    }

    let score = 0;
    const outQuestions = attempt.questions.map((q) => {
      const ans = attempt.answers.find((a) => a.questionId === q.id);
      const selectedLetter = ans?.choiceLetter ?? "";
      const correctLetter = toLetter(q.correctIndex);
      const isCorrect = !!(ans && ans.choiceIndex === q.correctIndex);
      if (isCorrect) score++;

      return {
        id: q.id,
        fuente: q.source,
        enunciado: q.prompt,
        opciones: q.options.map((opt, i) => `${toLetter(i)}) ${opt}`),
        // Mostrar solo el texto (sin duplicar letra)
        respuestaSeleccionada: q.options[ans.choiceIndex],
        respuestaCorrecta: q.options[q.correctIndex],
        letraSeleccionada: selectedLetter,
        letraCorrecta: correctLetter,
        acierto: isCorrect,
      };
    });

    const total = attempt.questions.length;
    const percent = Math.round((score / total) * 100);

    const resultForStudent = {
      score: `${score}/${total}`,
      percent: `${percent}%`,
    };

    const finishedAt = new Date().toISOString();
    const finalJson = {
      accion: "final",
      nombre: attempt.candidateName,
      dni: attempt.dni,
      puntuacion: `${score}/${total} (${percent}%)`,
      score_numerico: score,
      total_preguntas: total,
      porcentaje: percent,
      intentoId: attemptId,
      fuente_titulo: attempt.title || "",
      fuentes: attempt.urls || [],
      startedAt: attempt.startedAt,
      finishedAt,
      preguntas: outQuestions,
    };

    // Enviar a webhook de Make y esperar la respuesta para diagnosticar
    let webhookResult = { ok: false, status: 0, text: "disabled" };
    if (WEBHOOK_URL) {
      webhookResult = await postJSON(WEBHOOK_URL, finalJson).catch((e) => {
        console.error("[webhook] error:", e);
        return { ok: false, status: 0, text: String(e?.message || e) };
      });

      if (!webhookResult.ok) {
        console.error("[webhook] FAIL", webhookResult.status, webhookResult.text?.slice(0, 500));
      } else {
        console.log("[webhook] OK", webhookResult.status);
      }
    } else {
      console.warn("[webhook] WEBHOOK_URL no definido; no se envía a Make.");
    }

    return res.json({ resultForStudent, finalJson, webhook: webhookResult });
  } catch (err) {
    console.error("[finish] ERROR:", err);
    return res.status(500).json({ error: "Fallo al finalizar", detail: String(err?.message || err) });
  }
});

// --- Endpoint de prueba de webhook ---
app.post("/api/test-webhook", async (req, res) => {
  try {
    if (!WEBHOOK_URL) return res.status(400).json({ error: "WEBHOOK_URL no definido" });
    const payload = {
      accion: "prueba",
      now: new Date().toISOString(),
      echo: req.body || {},
    };
    const r = await postJSON(WEBHOOK_URL, payload);
    return res.json({ sentTo: WEBHOOK_URL, result: r, payload });
  } catch (e) {
    console.error("[/api/test-webhook] error:", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// Ruta raíz - opcional
app.get("/", (req, res) => {
  res.type("text/html").send(`
    <h1>✅ Resto Test Backend activo</h1>
    <p>Servidor corriendo correctamente.</p>
    <p><strong>NUM_QUESTIONS:</strong> ${NUM_QUESTIONS}</p>
    <ul>
      <li><a href="/health">/health</a> - Verificar estado</li>
      <li>POST <code>/api/start-test</code> - Iniciar test</li>
      <li>POST <code>/api/answer</code> - Enviar respuestas</li>
      <li>POST <code>/api/finish</code> - Finalizar test</li>
      <li>POST <code>/api/test-webhook</code> - Probar webhook</li>
    </ul>
  `);
});

// --- Arrancar servidor ---
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`✅ Servidor escuchando en http://localhost:${port}`);
});
