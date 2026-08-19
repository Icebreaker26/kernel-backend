import pool from '../../../db/database.js';

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
      SELECT codigo, email, portal_activado_at, primer_login
      FROM asociados
      WHERE portal_activo = true AND is_active = true
      ORDER BY portal_activado_at DESC NULLS LAST
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
