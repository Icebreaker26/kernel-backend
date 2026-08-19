import pg from 'pg';
import { env } from '../config/env.js';

// Devolver columnas DATE como string YYYY-MM-DD en lugar de objeto Date de JS.
// Sin esto, pg convierte a medianoche UTC y Colombia (UTC-5) muestra el día anterior.
pg.types.setTypeParser(1082, (val) => val);

const { Pool } = pg;

const pool = new Pool({ connectionString: env.DATABASE_URL });

pool.on('error', (err) => {
  console.error('Error inesperado en el pool de PostgreSQL:', err);
  process.exit(1);
});

export default pool;
