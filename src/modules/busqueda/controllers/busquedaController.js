import pool from '../../../db/database.js';

export const buscar = async (req, res, next) => {
  try {
    const q = (req.query.q ?? '').trim();
    if (q.length < 2) return res.json({ asociados: [], empresas: [], sorteos: [] });

    const termino = `%${q}%`;

    const [rAsociados, rEmpresas, rSorteos] = await Promise.all([
      pool.query(
        `SELECT codigo, nombre, apellido, nombre_empresa, is_active
         FROM asociados
         WHERE nombre ILIKE $1 OR apellido ILIKE $1 OR codigo ILIKE $1
            OR (nombre || ' ' || apellido) ILIKE $1
         ORDER BY is_active DESC, apellido, nombre
         LIMIT 8`,
        [termino]
      ),
      pool.query(
        `SELECT codigo, nombre, is_active
         FROM empresas
         WHERE nombre ILIKE $1 OR codigo ILIKE $1
         ORDER BY is_active DESC, nombre
         LIMIT 5`,
        [termino]
      ),
      pool.query(
        `SELECT id, nombre, estado
         FROM sorteos
         WHERE nombre ILIKE $1
         ORDER BY created_at DESC
         LIMIT 4`,
        [termino]
      ),
    ]);

    res.json({
      asociados: rAsociados.rows,
      empresas:  rEmpresas.rows,
      sorteos:   rSorteos.rows,
    });
  } catch (err) {
    next(err);
  }
};
