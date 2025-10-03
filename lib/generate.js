// lib/generate.js
import OpenAI from "openai";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const NUM_QUESTIONS = Number(process.env.NUM_QUESTIONS || 10);

// Barajar
function shuffle(array) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export async function generateQuestionBank({ text, role }) {
  const systemPrompt = `
Eres un evaluador de formación en restauración.
Genera preguntas de opción única (A–D), de nivel medio/difícil pero asequibles.
Usa EXCLUSIVAMENTE el texto proporcionado.
Cada pregunta: enunciado claro + 4 opciones plausibles + 1 sola correcta.
`.trim();

  const userPrompt = `
Puesto (texto libre): "${role || ""}"

Texto fuente (puede estar truncado):
"""${(text || "").slice(0, 30000)}"""
`.trim();

  const schema = {
    type: "object",
    properties: {
      questions: {
        type: "array",
        // Pedimos holgura para poder elegir exactamente NUM_QUESTIONS
        minItems: Math.max(NUM_QUESTIONS, 10),
        maxItems: Math.max(NUM_QUESTIONS + 2, 12),
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            prompt: { type: "string" },
            options: {
              type: "array",
              minItems: 4,
              maxItems: 4,
              items: { type: "string" },
            },
            correctIndex: { type: "integer", minimum: 0, maximum: 3 },
          },
          required: ["id", "prompt", "options", "correctIndex"],
          additionalProperties: false,
        },
      },
    },
    required: ["questions"],
    additionalProperties: false,
  };

  const resp = await openai.responses.create({
    model: "gpt-4o-mini",
    input: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "Questions",
        schema,
      },
    },
  });

  let jsonText = "";
  if (resp.output_text) jsonText = resp.output_text;
  else if (resp.output?.[0]?.content?.[0]?.text) jsonText = resp.output[0].content[0].text;
  else if (resp.content?.[0]?.text) jsonText = resp.content[0].text;

  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("La IA no devolvió JSON válido.");
  }

  if (!parsed?.questions || !Array.isArray(parsed.questions) || parsed.questions.length < NUM_QUESTIONS) {
    throw new Error(`La IA no devolvió suficientes preguntas (esperadas ${NUM_QUESTIONS}).`);
  }

  const selected = shuffle(parsed.questions).slice(0, NUM_QUESTIONS);

  // Validación
  selected.forEach((q, i) => {
    if (!q.id || !q.prompt || !Array.isArray(q.options) || q.options.length !== 4) {
      throw new Error(`Pregunta inválida en posición ${i}`);
    }
    if (typeof q.correctIndex !== "number" || q.correctIndex < 0 || q.correctIndex > 3) {
      throw new Error(`Índice correcto inválido en pregunta ${q.id}`);
    }
  });

  return selected;
}


