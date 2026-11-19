// API de "¿Qué pasóoo?": guarda las vacaciones y las entradas en Netlify Blobs
// y revisa las claves del árbol del lado del servidor.
import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import { timingSafeEqual, randomUUID } from "node:crypto";

const TIPOS = new Set(["chisme", "tarea", "conflicto"]);
const store = () => getStore({ name: "quepaso", consistency: "strong" });

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const str = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const isDate = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

// CLAVES="Agus:clave-de-agus:todo, Viki:clave-de-viki"
// ":todo" = ve las entradas de todos. Sin eso, cada uno ve solo lo que es para él o ella.
function parseClaves() {
  return String(process.env.CLAVES || "")
    .split(",")
    .map((p) => p.trim().split(":").map((x) => x.trim()))
    .filter((p) => p[0] && p[1])
    .map(([nombre, clave, extra]) => ({ nombre, clave, todo: extra === "todo" }));
}
function sameText(a, b) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
function whoIs(req) {
  const k = req.headers.get("x-clave") || "";
  if (!k) return null;
  return parseClaves().find((c) => sameText(c.clave, k)) || null;
}
const canSee = (who, e) => who.todo || (e.para || "Agus").toLowerCase() === who.nombre.toLowerCase();

// Límite simple por IP y por acción (por minuto), guardado en Blobs.
async function tooMany(req, context, action, max) {
  const ip = context.ip || req.headers.get("x-nf-client-connection-ip") || "x";
  const minute = Math.floor(Date.now() / 60000);
  const key = `rl/${action}/${ip}/${minute}`;
  const s = store();
  const n = Number((await s.get(key)) || 0) + 1;
  await s.set(key, String(n));
  return n > max;
}

async function readVacaciones() {
  return (await store().get("vacaciones", { type: "json" })) || {
    gente: [
      { nombre: "Agus", desde: "2026-11-23", hasta: "2026-12-14", monstruo: 3 },
      { nombre: "Viki", desde: "2026-11-30", hasta: "2026-12-07", monstruo: 5 },
    ],
  };
}
async function listEntradas() {
  const s = store();
  const { blobs } = await s.list({ prefix: "e/" });
  const all = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })));
  return all.filter((e) => e && !e.borrado).sort((a, b) => a.creado - b.creado);
}

const PROMPT = (q) => `Agus trabaja en contenidos y redes en una agencia de Argentina y ahora está de vacaciones. Alguien de su equipo tenía esta duda para preguntarle a ella:

"${q}"

Respondé como si fueras quien la conoce bien y adivina qué haría Agus. Español rioplatense, cálido y con humor, máximo 80 palabras. Dale una respuesta concreta y accionable, con criterio y sin esperar a que vuelva. Si es algo realmente delicado (un cliente muy enojado, plata, algo legal), decí que lo carguen como Conflicto en la cajita de la app. No inventes datos de clientes. Sin listas ni títulos, solo el texto.`;

export default async (req, context) => {
  const url = new URL(req.url);
  const parts = url.pathname.replace(/^\/api\/?/, "").split("/").filter(Boolean);
  const [route, id] = parts;
  let body = {};
  if (req.method !== "GET") {
    try { body = await req.json(); } catch { body = {}; }
  }

  try {
    // Lo que ve cualquiera
    if (route === "estado" && req.method === "GET") {
      const v = await readVacaciones();
      return json({ vacaciones: v.gente || [], preguntar: Boolean(process.env.ANTHROPIC_API_KEY) });
    }

    if (route === "vacaciones" && req.method === "PUT") {
      if (await tooMany(req, context, "vac", 20)) return json({ error: "Demasiados cambios" }, 429);
      const gente = (Array.isArray(body.gente) ? body.gente : []).slice(0, 30)
        .map((p) => ({ nombre: str(p.nombre, 20), desde: p.desde, hasta: p.hasta, monstruo: Math.abs(Number(p.monstruo) || 0) % 7 }))
        .filter((p) => p.nombre && isDate(p.desde) && isDate(p.hasta));
      const s = store();
      const prev = await s.get("vacaciones", { type: "json" });
      if (prev) await s.setJSON("vacaciones-anterior", prev); // por si alguien borra todo sin querer
      await s.setJSON("vacaciones", { gente, cambiado: Date.now() });
      return json({ ok: true, gente });
    }

    if (route === "entradas" && req.method === "POST" && !id) {
      if (await tooMany(req, context, "cargar", 15)) return json({ error: "Demasiadas cargas" }, 429);
      const tipo = TIPOS.has(body.tipo) ? body.tipo : null;
      const texto = str(body.texto, 400);
      if (!tipo || !texto) return json({ error: "Falta el tipo o el texto" }, 400);
      const e = {
        id: Date.now().toString(36) + "-" + randomUUID().slice(0, 8),
        tipo, texto,
        para: str(body.para, 20) || "Agus",
        padre: str(body.padre, 40) || null,
        autor: str(body.autor, 30),
        creado: Date.now(), revisado: false, revelado: false,
      };
      await store().setJSON("e/" + e.id, e);
      return json({ ok: true, id: e.id });
    }

    if (route === "preguntar" && req.method === "POST") {
      if (!process.env.ANTHROPIC_API_KEY) return json({ error: "Sin clave de Claude" }, 501);
      if (await tooMany(req, context, "preguntar", 5)) return json({ error: "Demasiadas preguntas" }, 429);
      const q = str(body.q, 300);
      if (!q) return json({ error: "Falta la pregunta" }, 400);
      const client = new Anthropic();
      const r = await client.beta.messages.create({
        model: "claude-opus-5-5",
        max_tokens: 2000,
        output_config: { effort: "low" },
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        messages: [{ role: "user", content: PROMPT(q) }],
      });
      if (r.stop_reason === "refusal") return json({ texto: "Mejor preguntale eso a Agus cuando vuelva." });
      const texto = r.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      return json({ texto: texto || "Hoy Claude está mudo. Probá de nuevo." });
    }

    // Lo que necesita clave
    if (route === "login" && req.method === "POST") {
      if (await tooMany(req, context, "login", 8)) return json({ error: "Demasiados intentos" }, 429);
      const k = str(body.clave, 100);
      const who = k && parseClaves().find((c) => sameText(c.clave, k));
      if (!who) return json({ error: "Clave incorrecta" }, 401);
      return json({ nombre: who.nombre, todo: who.todo });
    }

    if (route === "entradas" && req.method === "GET") {
      const who = whoIs(req);
      if (!who) return json({ error: "Clave incorrecta" }, 401);
      const entradas = (await listEntradas()).filter((e) => canSee(who, e));
      return json({ entradas });
    }

    if (route === "entradas" && req.method === "PATCH" && id) {
      const who = whoIs(req);
      if (!who) return json({ error: "Clave incorrecta" }, 401);
      const s = store();
      const e = await s.get("e/" + id, { type: "json" });
      if (!e || !canSee(who, e)) return json({ error: "No existe" }, 404);
      for (const k of ["revisado", "revelado", "borrado"]) if (typeof body[k] === "boolean") e[k] = body[k];
      await s.setJSON("e/" + id, e);
      return json({ ok: true });
    }

    return json({ error: "No existe" }, 404);
  } catch (err) {
    console.error(err);
    return json({ error: "Error del servidor" }, 500);
  }
};

export const config = { path: "/api/*" };
