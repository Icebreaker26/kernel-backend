import { createHmac } from 'crypto';
import pool from '../../../db/database.js';
import { env } from '../../../config/env.js';
import { eventoSchema, resumenSchema, EVENTOS } from '../schemas/analiticaSchema.js';

const ZONA = 'America/Bogota';

// ── Registro de eventos (público, sin cookies ni datos personales) ────────────

const RE_BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python-requests|okhttp|scrapy|httpclient|java\//i;

const dispositivoDe = (ua) => {
  if (/iPad|Tablet|PlayBook|Silk/i.test(ua) || (/Android/i.test(ua) && !/Mobile/i.test(ua))) return 'tablet';
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'movil';
  return 'escritorio';
};

// Host del sitio de origen; la navegación interna del propio sitio cuenta como "sin origen" para no inflar "Directo" ni el origen
const origenDe = (ref) => {
  if (!ref) return null;
  try {
    const host = new URL(ref).hostname.replace(/^www\./, '').toLowerCase().slice(0, 120);
    if (!host || host.endsWith('cooperativaprogresemos.coop') || host === 'localhost') return null;
    return host;
  } catch { return null; }
};

const rutaNormal = (r) => (r.length > 1 ? r.replace(/\/+$/, '') : r) || '/';

// Hash del visitante que CAMBIA cada día: permite contar visitantes distintos en un día, pero no seguir a nadie de un día a otro.
// No se guarda la IP ni el agente de usuario, solo este hash.
const hashVisitante = (ip, ua) => {
  const dia = new Date().toLocaleDateString('en-CA', { timeZone: ZONA });
  return createHmac('sha256', `${env.ANALITICA_SALT ?? env.JWT_SECRET}:${dia}`).update(`${ip}|${ua}`).digest('hex').slice(0, 16);
};

export const pubEvento = async (req, res, next) => {
  try {
    const d = eventoSchema.parse(req.body);
    const ua = String(req.headers['user-agent'] || '');

    // Telemetría: lo que no debe contarse se descarta en silencio (204), sin dar pistas
    const origenPeticion = req.headers.origin;
    const esperado = env.SITIO_URL ? env.SITIO_URL.replace(/\/$/, '') : null;
    if (origenPeticion && esperado && origenPeticion !== esperado) return res.status(204).end();   // solo el sitio propio
    if (!ua || RE_BOT.test(ua)) return res.status(204).end();

    await pool.query(
      `INSERT INTO analitica_eventos (tipo, ruta, evento, origen, dispositivo, visitante)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [d.tipo, rutaNormal(d.ruta), d.tipo === 'clic' ? d.evento : null, d.tipo === 'vista' ? origenDe(d.ref) : null,
        dispositivoDe(ua), hashVisitante(req.ip, ua)]);
    res.status(204).end();
  } catch (err) { next(err); }
};

// ── Panel (Kernel) ────────────────────────────────────────────────────────────

const sumarDias = (yyyyMmDd, n) => {
  const [a, m, d] = yyyyMmDd.split('-').map(Number);
  const f = new Date(Date.UTC(a, m - 1, d + n));
  return f.toISOString().slice(0, 10);
};
const diferenciaDias = (desde, hasta) => Math.round((Date.parse(`${hasta}T00:00:00Z`) - Date.parse(`${desde}T00:00:00Z`)) / 86400000);

// Eventos del rango, con el día en hora de Colombia
const EV = `ev AS (
  SELECT tipo, ruta, evento, origen, dispositivo, visitante, (created_at AT TIME ZONE '${ZONA}')::date AS dia
    FROM analitica_eventos
   WHERE created_at >= ($1::date)::timestamp AT TIME ZONE '${ZONA}'
     AND created_at <  (($2::date + 1)::timestamp AT TIME ZONE '${ZONA}')
)`;

// "Visitantes" = visitantes distintos por día, sumados: como el hash cambia a diario, alguien que vuelve otro día cuenta otra vez
const totalesDe = async (desde, hasta) => {
  const { rows: [t] } = await pool.query(
    `WITH ${EV}
     SELECT (SELECT COUNT(*) FROM ev WHERE tipo = 'vista')::int AS vistas,
            (SELECT COUNT(*) FROM ev WHERE tipo = 'clic')::int  AS clics,
            COALESCE((SELECT SUM(n) FROM (SELECT COUNT(DISTINCT visitante) AS n FROM ev WHERE tipo = 'vista' GROUP BY dia) x), 0)::int AS visitantes`,
    [desde, hasta]);
  return t;
};

export const resumen = async (req, res, next) => {
  try {
    const q = resumenSchema.parse(req.query);
    const { rows: [{ hoy }] } = await pool.query(`SELECT to_char((NOW() AT TIME ZONE '${ZONA}')::date, 'YYYY-MM-DD') AS hoy`);
    const hasta = q.hasta ?? hoy;
    const desde = q.desde ?? sumarDias(hasta, -((q.dias ?? 30) - 1));
    const dias = diferenciaDias(desde, hasta) + 1;
    if (dias < 1 || dias > 731) return res.status(400).json({ error: 'El rango de fechas no es válido (máximo 2 años)' });

    const [serie, paginas, origenes, dispositivos, clics, actual, anterior] = await Promise.all([
      pool.query(
        `WITH ${EV}
         SELECT to_char(d, 'YYYY-MM-DD') AS dia,
                COUNT(ev.*) FILTER (WHERE ev.tipo = 'vista')::int AS vistas,
                COUNT(DISTINCT ev.visitante) FILTER (WHERE ev.tipo = 'vista')::int AS visitantes
           FROM generate_series($1::date, $2::date, '1 day') d
           LEFT JOIN ev ON ev.dia = d::date
          GROUP BY d ORDER BY d`, [desde, hasta]),
      pool.query(
        `WITH ${EV}
         SELECT ruta, COUNT(*)::int AS vistas, COUNT(DISTINCT (dia, visitante))::int AS visitantes
           FROM ev WHERE tipo = 'vista' GROUP BY ruta ORDER BY vistas DESC, ruta LIMIT 10`, [desde, hasta]),
      pool.query(
        `WITH ${EV}
         SELECT COALESCE(origen, 'Directo o interno') AS origen, COUNT(*)::int AS vistas
           FROM ev WHERE tipo = 'vista' GROUP BY 1 ORDER BY vistas DESC, 1 LIMIT 10`, [desde, hasta]),
      pool.query(
        `WITH ${EV}
         SELECT dispositivo, COUNT(*)::int AS vistas FROM ev WHERE tipo = 'vista' GROUP BY 1 ORDER BY vistas DESC`, [desde, hasta]),
      pool.query(
        `WITH ${EV}
         SELECT evento, COUNT(*)::int AS total FROM ev WHERE tipo = 'clic' GROUP BY 1 ORDER BY total DESC`, [desde, hasta]),
      totalesDe(desde, hasta),
      // Periodo anterior de la misma duración, para comparar
      totalesDe(sumarDias(desde, -dias), sumarDias(desde, -1)),
    ]);

    res.set('Cache-Control', 'private, no-store');
    res.json({
      rango: { desde, hasta, dias },
      totales: { ...actual, anterior },
      serie: serie.rows,
      paginas: paginas.rows,
      origenes: origenes.rows,
      dispositivos: dispositivos.rows,
      clics: clics.rows.map((c) => ({ evento: c.evento, nombre: EVENTOS[c.evento] ?? c.evento, total: c.total })),
    });
  } catch (err) { next(err); }
};
