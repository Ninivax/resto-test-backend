import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { extractMainTextFromUrl, extractMany } from "./lib/extract.js";
import { generateQuestionBank } from "./lib/generate.js";

const app = express();
const NUM_QUESTIONS = Number(process.env.NUM_QUESTIONS || 10);
const WEBHOOK_URL = process.env.WEBHOOK_URL || "";

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

// Helper POST JSON (para Make)
async function postJSON(url, body, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    const text = await res.text().catch(() => "");
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(t);
  }
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

    // Si piden una sola fuente, mantenemos compatibilidad: generamos solo de esa
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

      // Etiquetar con la fuente y garantizar IDs únicos
      const tagged = bank.map((q) => ({
        ...q,
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
        if (!text || text.trim().length < 200) {
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

    // 2) Generar banco por cada fuente (cada llamada genera NUM_QUESTIONS, luego cortamos)
    let banks = {};
    try {
      for (const key of Object.keys(SOURCES)) {
        const bank = await generateQuestionBank({ text: texts[key], role: "" }); // devuelve NUM_QUESTIONS
        banks[key] = bank;
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
        fuente: q.source, // 👈 añadimos la fuente de origen
        enunciado: q.prompt,
        opciones: q.options.map((opt, i) => `${toLetter(i)}) ${opt}`),
        // 👇 Arreglo: ya no duplicamos la letra; solo texto de la opción
        respuestaSeleccionada: q.options[ans.choiceIndex],
        respuestaCorrecta: q.options[q.correctIndex],
        // Letras separadas (útil si guardas en Excel)
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

    // Enviar a webhook de Make (no bloqueamos la respuesta al alumno)
    if (WEBHOOK_URL) {
      postJSON(WEBHOOK_URL, finalJson)
        .then((r) => {
          if (!r.ok) console.error("[webhook] fallo:", r.status, r.text);
          else console.log("[webhook] enviado OK");
        })
        .catch((e) => console.error("[webhook] error:", e));
    } else {
      console.warn("[webhook] WEBHOOK_URL no definido; no se envía a Make.");
    }

    return res.json({ resultForStudent, finalJson });
  } catch (err) {
    console.error("[finish] ERROR:", err);
    return res.status(500).json({ error: "Fallo al finalizar", detail: String(err?.message || err) });
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
    </ul>
  `);
});

// --- Arrancar servidor ---
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`✅ Servidor escuchando en http://localhost:${port}`);
});


