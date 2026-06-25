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

    let importados = 0;
    let errores = [];

    await client.query('BEGIN');

    for (const fila of registros) {
      const result = importarFilaSchema.safeParse(fila);
      if (!result.success) {
        errores.push({ fila: fila.codigo ?? '?', error: result.error.flatten() });
        continue;
      }

      const d = result.data;
      const password_hash = await bcrypt.hash(d.codigo, 10);

      await client.query(
        `INSERT INTO asociados
           (codigo, apellido, nombre, direccion, movil, clase_cuota, empresa_dsto, nombre_empresa, ciudad, password_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (codigo) DO UPDATE SET
           apellido       = EXCLUDED.apellido,
           nombre         = EXCLUDED.nombre,
           direccion      = EXCLUDED.direccion,
           movil          = EXCLUDED.movil,
           clase_cuota    = EXCLUDED.clase_cuota,
           empresa_dsto   = EXCLUDED.empresa_dsto,
           nombre_empresa = EXCLUDED.nombre_empresa,
           ciudad         = EXCLUDED.ciudad,
           updated_at     = now()`,
        [d.codigo, d.apellido, d.nombre, d.direccion, d.movil,
         d.clase_cuota, d.empresa_dsto, d.nombre_empresa, d.ciudad, password_hash]
      );
      importados++;
    }

    await client.query('COMMIT');
    res.json({ importados, errores, total: registros.length });
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
