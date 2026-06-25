import pool from '../src/db/database.js';

export default async () => {
  await pool.end();
};
