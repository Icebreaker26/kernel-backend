import bcrypt from 'bcrypt';
import pool from '../src/db/database.js';

const usuarios = [
  {
    nombre: 'Alejandro Torres',
    email: 'alejandro.torres0826@gmail.com',
    password: 'kernel2026',
    rol: 'admin',
  },
];

const hash = async (password) => bcrypt.hash(password, 10);

for (const u of usuarios) {
  const password_hash = await hash(u.password);
  await pool.query(
    `INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
     VALUES ($1, $2, $3, $4, true, true)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           rol           = EXCLUDED.rol,
           is_approved   = true,
           is_active     = true`,
    [u.nombre, u.email, password_hash, u.rol]
  );
  console.log(`✓ ${u.email}`);
}

await pool.end();
console.log('Seed completado.');
