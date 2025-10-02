
import "dotenv/config";
import express from "express";
import cors from "cors";
import crypto from "crypto";
import { extractMainTextFromUrl, extractMany } from "./lib/extract.js";
import { generateQuestionBank } from "./lib/generate.js";

const app = express();

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
const toLetter = (i) => String.fromCharCode(65 + i); // 0->A
function letterToIndex(letter) {
  const L = String(letter || "").trim().toUpperCase();
  return { A: 0, B: 1, C: 2, D: 3 }[L] ?? -1;
}

// --- Salud ---
app.get("/health", (req, res) => res.json({ ok: true }));

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

    // Elegir fuentes
    let urls = [];
    if (source === "procedimiento") urls = [SOURCES.procedimiento];
    else if (source === "maridaje") urls = [SOURCES.maridaje];
    else if (source === "recetario") urls = [SOURCES.recetario];
    else urls = Object.values(SOURCES);

    console.log("[start-test] fuentes:", urls);

    // 1) Extraer texto
    let title, text;
    try {
      const out =
        urls.length === 1
          ? await extractMainTextFromUrl(urls[0])
          : await extractMany(urls);
      title = out.title;
      text = out.text;
      console.log(
        "[start-test] extracción OK · chars:",
        (text && text.length) || 0
      );
      if (!text || text.trim().length < 200) {
        throw new Error(
          "Texto extraído insuficiente (menos de 200 caracteres)"
        );
      }
    } catch (e) {
      console.error("[start-test] ERROR extrayendo texto:", e);
      return res.status(500).json({
        error: "Fallo al extraer texto de las fuentes",
        detail: String(e?.message || e),
      });
    }

    // 2) Generar preguntas con IA
    let questions;
    try {
      questions = await generateQuestionBank({ text, role: "" });
      if (!Array.isArray(questions) || questions.length !== 5) {
        console.warn(
          "[start-test] advertencia: se esperaban 5 preguntas, llegaron:",
          questions?.length
        );
      }
      console.log(
        "[start-test] generación OK · preguntas:",
        questions?.length
      );
    } catch (e) {
      console.error("[start-test] ERROR generando preguntas:", e);
      return res.status(500).json({
        error: "Fallo al generar preguntas con IA",
        detail: String(e?.message || e),
      });
    }

    // 3) Guardar intento
    const attemptId = crypto.randomUUID();
    attempts.set(attemptId, {
      dni,
      candidateName,
      urls,
      title,
      startedAt: new Date().toISOString(),
      questions, // [{ id, prompt, options, correctIndex }]
      answers: [],
    });

    console.log(
      `[start-test] OK · attemptId=${attemptId} · ${Date.now() - t0}ms`
    );

    // 4) Respuesta (sin correctas)
    return res.json({
      attemptId,
      sourceTitle: title,
      questions: questions.map((q) => ({
        id: q.id,
        prompt: q.prompt,
        options: q.options, // A–D
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
app.post("/api/finish", (req, res) => {
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
      if (ans && ans.choiceIndex === q.correctIndex) score++;

      return {
        enunciado: q.prompt,
        opciones: q.options.map((opt, i) => `${toLetter(i)}) ${opt}`),
        respuestaSeleccionada: `${selectedLetter}) ${q.options[ans.choiceIndex]}`,
        respuestaCorrecta: `${correctLetter}) ${q.options[q.correctIndex]}`,
      };
    });

    const total = attempt.questions.length;
    const percent = Math.round((score / total) * 100);

    const resultForStudent = {
      score: `${score}/${total}`,
      percent: `${percent}%`,
    };

    const finalJson = {
      accion: "final",
      nombre: attempt.candidateName,
      dni: attempt.dni,
      puntuacion: `${score}/${total} (${percent}%)`,
      preguntas: outQuestions,
    };

    return res.json({ resultForStudent, finalJson });
  } catch (err) {
    console.error("[finish] ERROR:", err);
    return res.status(500).json({ error: "Fallo al finalizar", detail: String(err?.message || err) });
  }
});

// --- Arrancar servidor ---
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`✅ Servidor escuchando en http://localhost:${port}`);
});
