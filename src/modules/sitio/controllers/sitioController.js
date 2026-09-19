import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { s3 } from '../../../config/s3.js';
import { env } from '../../../config/env.js';

// Videos de ayuda de la página pública /pagos. Están en el bucket (kernel/sitio/tutoriales/<clave>.mp4);
// solo se sirven estas claves, nunca una ruta arbitraria.
export const TUTORIALES = ['que-es', 'web', 'app'];

// Dura varias horas: un video en pausa que se reanuda o se adelanta vuelve a pedir el archivo a S3 con la misma URL
const VIGENCIA_SEGUNDOS = 6 * 3600;

export const pubTutorial = async (req, res, next) => {
  try {
    const { clave } = req.params;
    if (!TUTORIALES.includes(clave)) return res.status(404).json({ error: 'Video no encontrado' });
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: `kernel/sitio/tutoriales/${clave}.mp4`,
      ResponseContentType: 'video/mp4',
    }), { expiresIn: VIGENCIA_SEGUNDOS });
    res.set('Cache-Control', 'no-store');   // la redirección lleva una firma que caduca
    // Helmet pone same-origin por defecto; el sitio público (otro origen) tiene que poder incrustar el video
    res.set('Cross-Origin-Resource-Policy', 'cross-origin');
    res.redirect(302, url);
  } catch (err) { next(err); }
};
