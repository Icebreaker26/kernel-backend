import bcrypt from 'bcrypt';

export const up = async (pgm) => {
  const password_hash = await bcrypt.hash('kernel2026', 10);

  pgm.sql(`
    INSERT INTO global_usuarios (nombre, email, password_hash, rol, is_active, is_approved)
    VALUES (
      'Alejandro Torres',
      'alejandro.torres0826@gmail.com',
      '${password_hash}',
      'admin',
      true,
      true
    )
    ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_approved = true, is_active = true;
  `);
};

export const down = (pgm) => {
  pgm.sql(`DELETE FROM global_usuarios WHERE email = 'alejandro.torres0826@gmail.com';`);
};
