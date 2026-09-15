import pool from '../db/database.js';
import { redisClient } from '../config/redis.js';

// Invalida todos los tokens activos de un usuario empleado.
// Usa sessions_valid_from + NOW()+1s para cubrir la ventana de 1 segundo del truncado iat.
export const revocarSesiones = async (userId) => {
  await pool.query(
    `UPDATE global_usuarios SET sessions_valid_from = NOW() + INTERVAL '1 second' WHERE id = $1`,
    [userId]
  );
  if (redisClient) {
    await redisClient.del(`uvf:${userId}`).catch(() => {});
  }
};
