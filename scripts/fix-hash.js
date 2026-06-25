import bcrypt from 'bcrypt';
import pool from '../src/db/database.js';

const hash = await bcrypt.hash('kernel2026', 10);
const { rowCount } = await pool.query(
  'UPDATE global_usuarios SET password_hash = $1 WHERE email = $2',
  [hash, 'alejandro.torres0826@gmail.com']
);
console.log(`Actualizado: ${rowCount} fila`);
await pool.end();
