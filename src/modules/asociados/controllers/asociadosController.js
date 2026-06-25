import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { parse } from 'csv-parse/sync';
import pool from '../../../db/database.js';
import { env } from '../../../config/env.js';
import { loginAsociadoSchema, importarFilaSchema } from '../schemas/asociadosSchema.js';

export const loginAsociado = async (req, res, next) => {
  try {
    const { codigo, password } = loginAsociadoSchema.parse(req.body);

    const { rows } = await pool.query(
      `SELECT codigo, nombre, apellido, password_hash
       FROM asociados WHERE codigo = $1 AND is_active = true`,
      [codigo]
    );

    const asociado = rows[0];
    if (!asociado || !(await bcrypt.compare(password, asociado.password_hash))) {
      return res.status(401).json({ error: 'Código o contraseña incorrectos' });
    }

    const token = jwt.sign(
      { id: asociado.codigo, nombre: asociado.nombre, tipo: 'asociado' },
      env.JWT_SECRET,
      { expiresIn: '8h' }
    );

    res.cookie('token_asociado', token, {
      httpOnly: true,
      secure: env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 8 * 60 * 60 * 1000,
    });

    res.json({ codigo: asociado.codigo, nombre: asociado.nombre, apellido: asociado.apellido });
  } catch (err) {
    next(err);
  }
};

export const logoutAsociado = (_req, res) => {
  res.clearCookie('token_asociado');
  res.json({ message: 'Sesión cerrada' });
};

export const meAsociado = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT codigo, nombre, apellido, direccion, movil,
              clase_cuota, empresa_dsto, nombre_empresa, ciudad
       FROM asociados WHERE codigo = $1`,
      [req.asociado.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Asociado no encontrado' });
    res.json(rows[0]);
  } catch (err) {
    next(err);
  }
};

export const importarCSV = async (req, res, next) => {
  const client = await pool.connect();
  try {
    if (!req.file) return res.status(400).json({ error: 'No se adjuntó ningún archivo' });

    const registros = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
    });

    const errores = [];
    const validos = [];

    for (const fila of registros) {
      const result = importarFilaSchema.safeParse(fila);
      if (!result.success) {
        errores.push({ fila: fila.codigo ?? '?', error: result.error.flatten() });
      } else {
        validos.push(result.data);
      }
    }

    // Hashear en lotes de 50 con costo 4 — password inicial, no requiere seguridad máxima
    const BATCH = 50;
    const hashes = [];
    for (let i = 0; i < validos.length; i += BATCH) {
      const lote = validos.slice(i, i + BATCH);
      const lotehashes = await Promise.all(lote.map((d) => bcrypt.hash(d.codigo, 4)));
      hashes.push(...lotehashes);
    }

    const INSERT_BATCH = 200;
    const codigosCSV   = validos.map((d) => d.codigo);

    await client.query('BEGIN');

    // 1. Upsert de todos los del CSV (nuevos + actualizados)
    let nuevos      = 0;
    let actualizados = 0;

    for (let i = 0; i < validos.length; i += INSERT_BATCH) {
      const lote   = validos.slice(i, i + INSERT_BATCH);
      const params = [];
      const values = lote.map((d, j) => {
        const base = j * 10;
        params.push(d.codigo, d.apellido, d.nombre, d.direccion, d.movil,
                    d.clase_cuota, d.empresa_dsto, d.nombre_empresa, d.ciudad, hashes[i + j]);
        return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8},$${base+9},$${base+10})`;
      }).join(',');

      const { rows } = await client.query(
        `INSERT INTO asociados
           (codigo, apellido, nombre, direccion, movil, clase_cuota, empresa_dsto, nombre_empresa, ciudad, password_hash)
         VALUES ${values}
         ON CONFLICT (codigo) DO UPDATE SET
           apellido       = EXCLUDED.apellido,
           nombre         = EXCLUDED.nombre,
           direccion      = EXCLUDED.direccion,
           movil          = EXCLUDED.movil,
           clase_cuota    = EXCLUDED.clase_cuota,
           empresa_dsto   = EXCLUDED.empresa_dsto,
           nombre_empresa = EXCLUDED.nombre_empresa,
           ciudad         = EXCLUDED.ciudad,
           is_active      = true,
           updated_at     = now()
         RETURNING (xmax = 0) AS es_nuevo`,
        params
      );

      rows.forEach((r) => r.es_nuevo ? nuevos++ : actualizados++);
    }

    // 2. Retirar asociados que ya no están en el CSV
    const { rowCount: retirados } = await client.query(
      `UPDATE asociados SET is_active = false, updated_at = now()
       WHERE codigo != ALL($1) AND is_active = true`,
      [codigosCSV]
    );

    await client.query('COMMIT');
    res.json({ nuevos, actualizados, retirados, errores, total: registros.length });
  } catch (err) {
    await client.query('ROLLBACK');
    next(err);
  } finally {
    client.release();
  }
};

export const listarAsociados = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT codigo, nombre, apellido, movil, clase_cuota, nombre_empresa, ciudad, is_active
       FROM asociados ORDER BY apellido, nombre`
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
};
