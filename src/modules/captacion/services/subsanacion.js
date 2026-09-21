import pool from '../../../db/database.js';

export const ITEMS_SUBSANACION = {
  cedula_frente: 'la foto del frente de tu cédula',
  cedula_reverso: 'la foto del reverso de tu cédula',
  firma: 'tu firma',
  datos: 'tus datos del formulario',
};

// La subsanación abierta de la solicitud (o null). Solo puede haber una.
export const subsanacionAbierta = async (vinculacionId, db = pool) => {
  const { rows: [s] } = await db.query(
    `SELECT id, items, motivo, created_at FROM captacion_subsanaciones WHERE vinculacion_id = $1 AND resuelta_at IS NULL`, [vinculacionId]
  );
  return s ?? null;
};

/**
 * Guarda la firma vigente en el historial y deja la solicitud sin firma para que la persona firme de nuevo. Se conserva TODO lo
 * que la respaldaba (imagen, trazos, hash, snapshot, verificación del correo y el id del PDF sellado, que sigue en `archivos`).
 * `client` debe estar dentro de una transacción.
 */
export const archivarFirma = async (client, vinculacionId, subsanacionId) => {
  await client.query(
    `INSERT INTO captacion_firmas_historial (vinculacion_id, subsanacion_id, datos)
     SELECT id, $2, jsonb_build_object(
       'firma_png', firma_png, 'firma_trazos', firma_trazos, 'firma_at', firma_at, 'firma_ip', firma_ip,
       'firma_user_agent', firma_user_agent, 'firma_doc_hash', firma_doc_hash, 'version_consentimiento', version_consentimiento,
       'formulario_snapshot', formulario_snapshot, 'firma_electronica_at', firma_electronica_at,
       'firma_electronica_version', firma_electronica_version, 'firma_verificacion', firma_verificacion,
       'seccion_firma_at', seccion_firma_at, 'firma_pdf_archivo_id', firma_pdf_archivo_id,
       'firma_pdf_hash', firma_pdf_hash, 'firma_pdf_at', firma_pdf_at)
       FROM captacion_vinculaciones WHERE id = $1`,
    [vinculacionId, subsanacionId]
  );
  await client.query(
    `UPDATE captacion_vinculaciones
        SET firma_png = NULL, firma_trazos = NULL, firma_at = NULL, firma_ip = NULL, firma_user_agent = NULL,
            firma_doc_hash = NULL, version_consentimiento = NULL, formulario_snapshot = NULL,
            firma_electronica_at = NULL, firma_electronica_version = NULL, firma_verificacion = NULL,
            seccion_firma_at = NULL, firma_pdf_archivo_id = NULL, firma_pdf_hash = NULL, firma_pdf_at = NULL,
            updated_at = NOW()
      WHERE id = $1`,
    [vinculacionId]
  );
};

const escapar = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const textoSubsanacion = ({ nombres, items, motivo, enlace, asesor }) => {
  const lista = items.map((i) => ITEMS_SUBSANACION[i]).filter(Boolean);
  const pedido = lista.length > 1 ? `${lista.slice(0, -1).join(', ')} y ${lista.at(-1)}` : lista[0];
  const asunto = 'Necesitamos que corrijas algo de tu solicitud — Cooperativa Progresemos';
  const texto = [
    `Hola ${nombres},`,
    '',
    `Al revisar tu solicitud de asociación necesitamos que corrijas ${pedido}.`,
    `Motivo: ${motivo}`,
    '',
    `Entra a tu enlace, hazlo y envía la corrección: ${enlace}`,
    '',
    `Si tienes dudas, escríbele a ${asesor}.`,
    '',
    '— Cooperativa Progresemos',
  ].join('\n');
  const html = `<p>Hola ${escapar(nombres)},</p>
<p>Al revisar tu solicitud de asociación necesitamos que corrijas <strong>${escapar(pedido)}</strong>.</p>
<p><strong>Motivo:</strong> ${escapar(motivo)}</p>
<p><a href="${escapar(enlace)}">Entrar a mi solicitud y corregirlo</a></p>
<p>Si tienes dudas, escríbele a ${escapar(asesor)}.</p>
<p>— Cooperativa Progresemos</p>`;
  return { asunto, texto, html };
};
