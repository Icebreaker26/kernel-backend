import pool from '../../../db/database.js';
import { sha256 } from '../../../services/hashCanonico.js';

/**
 * Texto íntegro de lo que la persona acepta en cada paso, por versión. Es la fuente que se sella junto a la firma: el frontend
 * lo muestra tal cual. Si se cambia una palabra del texto en pantalla, hay que subir la versión aquí (y en el controlador) para
 * que el texto anterior siga demostrando lo que firmaron quienes lo aceptaron antes.
 */
export const TEXTOS = {
  habeas_data: {
    'hd-v1.0': [
      'Autorizo a Cooperativa Progresemos para recolectar, almacenar, usar y consultar mis datos personales, conforme a la Ley 1581 de 2012, con estas finalidades:',
      '- Tramitar y gestionar mi vinculación como asociado.',
      '- Verificar la información que suministro y cumplir las normas de prevención de lavado de activos.',
      '- Administrar mis aportes, beneficios y servicios como asociado.',
      '- Comunicarme información de la cooperativa relacionada con mi asociación.',
      'Puedo conocer, actualizar, rectificar y solicitar la supresión de mis datos, o revocar esta autorización, escribiendo a la cooperativa o llamando a su línea de atención.',
      'Casilla: Leí y autorizo el tratamiento de mis datos personales',
    ].join('\n'),
  },
  declaracion: {
    'v1.0': [
      'Declaro que la información que suministré es verídica y autorizo a Cooperativa Progresemos para verificarla. Acepto los estatutos y reglamentos de la cooperativa y el tratamiento de mis datos personales conforme a la Ley 1581 de 2012.',
      'Casilla: Leí y acepto la declaración anterior',
    ].join('\n'),
  },
  firma_electronica: {
    'fe-v1.0': [
      'Tu firma en este formulario es una firma electrónica (Ley 527 de 1999 y Decreto 2364 de 2012). Guardamos junto a ella la fecha y hora, tu dirección IP y el dispositivo, y una huella digital (hash) del documento para comprobar que no se altera después de firmado.',
      'Casilla: Acepto firmar electrónicamente y que esta firma tiene el mismo valor que mi firma manuscrita',
    ].join('\n'),
  },
};

/**
 * Devuelve { tipo, version, hash } del texto y se asegura de que quede guardado (una sola vez, inmutable) en
 * captacion_textos_consentimiento. Devuelve null si esa versión no existe en el catálogo.
 */
export const registrarTexto = async (tipo, version, db = pool) => {
  const texto = TEXTOS[tipo]?.[version];
  if (!texto) return null;
  const hash = sha256(texto);
  await db.query(
    `INSERT INTO captacion_textos_consentimiento (tipo, version, texto, hash) VALUES ($1,$2,$3,$4)
     ON CONFLICT (tipo, version) DO NOTHING`,
    [tipo, version, texto, hash]
  );
  return { tipo, version, hash };
};
