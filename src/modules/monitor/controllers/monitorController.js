import bcrypt from 'bcrypt';
import pool from '../../../db/database.js';
import { env } from '../../../config/env.js';
import { generarPassword } from '../../asociados/controllers/asociadosController.js';
import { enviarCredencialesPortal } from '../../../services/emailService.js';

export const metricas = async (req, res, next) => {
  try {
    const [activosQ, hoyQ, semanaQ, emailsQ, porDiaQ] = await Promise.all([
      pool.query(`SELECT COUNT(*) FROM asociados WHERE portal_activo = true AND is_active = true`),
      pool.query(`SELECT COUNT(*) FROM asociados WHERE portal_activo = true AND portal_activado_at >= CURRENT_DATE`),
      pool.query(`SELECT COUNT(*) FROM asociados WHERE portal_activo = true AND portal_activado_at >= NOW() - INTERVAL '7 days'`),
      pool.query(`SELECT estado, COUNT(*) FROM email_logs GROUP BY estado`),
      pool.query(`
        SELECT DATE(portal_activado_at AT TIME ZONE 'America/Bogota') AS dia, COUNT(*) AS total
        FROM asociados
        WHERE portal_activo = true AND portal_activado_at >= NOW() - INTERVAL '14 days'
        GROUP BY dia ORDER BY dia
      `),
    ]);

    const emailStats = {};
    emailsQ.rows.forEach((r) => { emailStats[r.estado] = Number(r.count); });

    res.json({
      total_activos:        Number(activosQ.rows[0].count),
      activaciones_hoy:     Number(hoyQ.rows[0].count),
      activaciones_semana:  Number(semanaQ.rows[0].count),
      emails_enviados:      emailStats.enviado ?? 0,
      emails_error:         emailStats.error ?? 0,
      por_dia:              porDiaQ.rows.map((r) => ({ dia: r.dia, total: Number(r.total) })),
    });
  } catch (err) { next(err); }
};

export const ingresos = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT a.codigo, a.nombre, a.apellido, a.email, a.portal_activado_at, a.primer_login,
             el.estado AS email_estado, el.created_at AS email_at, el.error_msg
      FROM asociados a
      LEFT JOIN LATERAL (
        SELECT estado, created_at, error_msg
        FROM email_logs
        WHERE asociado_codigo = a.codigo AND tipo = 'credenciales_portal'
        ORDER BY created_at DESC
        LIMIT 1
      ) el ON true
      WHERE a.portal_activo = true AND a.is_active = true
      ORDER BY a.portal_activado_at DESC NULLS LAST
      LIMIT 200
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

export const emails = async (req, res, next) => {
  try {
    const { rows } = await pool.query(`
      SELECT id, tipo, destinatario, asociado_codigo, estado, error_msg, created_at
      FROM email_logs
      ORDER BY created_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (err) { next(err); }
};

export const reintentarPendientes = async (req, res, next) => {
  try {
    // Asociados cuyo último intento de email falló
    const { rows } = await pool.query(`
      SELECT a.codigo, a.email
      FROM asociados a
      INNER JOIN LATERAL (
        SELECT estado FROM email_logs
        WHERE asociado_codigo = a.codigo AND tipo = 'credenciales_portal'
        ORDER BY created_at DESC LIMIT 1
      ) el ON el.estado = 'error'
      WHERE a.portal_activo = true AND a.is_active = true AND a.email IS NOT NULL
    `);

    if (rows.length === 0) return res.json({ procesados: 0, resultados: [] });

    const resultados = [];
    for (const { codigo, email } of rows) {
      try {
        const password = generarPassword();
        const hash = await bcrypt.hash(password, 10);
        await pool.query(
          `UPDATE asociados SET password_hash = $1, primer_login = true, updated_at = NOW() WHERE codigo = $2`,
          [hash, codigo]
        );
        await enviarCredencialesPortal(email, codigo, password);
        resultados.push({ codigo, ok: true });
      } catch (err) {
        resultados.push({ codigo, ok: false, error: err.message });
      }
    }

    res.json({ procesados: rows.length, resultados });
  } catch (err) { next(err); }
};

export const relayStatus = async (req, res, next) => {
  try {
    if (!env.RELAY_URL) return res.json({ online: false, motivo: 'no_configurado' });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const r = await fetch(`${env.RELAY_URL}/health`, { signal: controller.signal });
      clearTimeout(timer);
      const data = await r.json();
      res.json({ online: data.ok === true });
    } catch {
      clearTimeout(timer);
      res.json({ online: false, motivo: 'timeout' });
    }
  } catch (err) { next(err); }
};
