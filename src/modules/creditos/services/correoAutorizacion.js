const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const moneda = (n) => `$${Number(n).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`;

/**
 * Correo a la empresa pidiendo autorización del crédito de un asociado. Lleva solo lo que la empresa necesita para decidir:
 * quién es el asociado, la cuota a descontar y el radicado. NO lleva el valor total, la categoría ni datos financieros del
 * asociado, y no adjunta documentos. La respuesta llega directo al asesor (Reply-To).
 */
export const construirCorreoAutorizacion = ({ asociado, empresa, radicado, cuotaMensual, cuotas, asesor }) => {
  const nombre = `${asociado.nombre} ${asociado.apellido}`.replace(/\s+/g, ' ').trim();
  const filas = [
    ['Asociado', nombre],
    ['Documento', asociado.codigo],
    ['Empresa', empresa],
    ...(cuotaMensual ? [['Cuota mensual a descontar', moneda(cuotaMensual)]] : []),
    ...(cuotas ? [['Número de cuotas', String(cuotas)]] : []),
    ['Radicado', radicado],
  ];
  const asunto = `Solicitud de autorización de crédito — ${nombre} — ${radicado}`;
  const html = `<!DOCTYPE html><html lang="es"><body style="margin:0;padding:24px;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation"><tr><td align="center">
    <table cellpadding="0" cellspacing="0" role="presentation" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#065B8E;padding:20px 28px;color:#ffffff;font-size:13px;letter-spacing:3px;">COOPERATIVA PROGRESEMOS</td></tr>
      <tr><td style="padding:28px;color:#1e293b;font-size:15px;line-height:1.5;">
        <p style="margin:0 0 14px;">Cordial saludo.</p>
        <p style="margin:0 0 18px;">La Cooperativa Progresemos recibió una solicitud de crédito de un colaborador de su empresa y requiere su <b>autorización para descontar la cuota por nómina</b>:</p>
        <table cellpadding="0" cellspacing="0" role="presentation" style="width:100%;border-collapse:collapse;margin:0 0 18px;">
          ${filas.map(([k, v]) => `<tr><td style="padding:6px 0;color:#64748b;width:44%;">${esc(k)}</td><td style="padding:6px 0;font-weight:600;">${esc(v)}</td></tr>`).join('')}
        </table>
        <p style="margin:0 0 14px;">Por favor <b>responda a este correo</b> indicando si autoriza o no el descuento. Su respuesta llegará directamente al asesor ${esc(asesor.nombre)}, quien continuará el trámite.</p>
        <p style="margin:0;color:#94a3b8;font-size:12px;">Cooperativa Progresemos. Si este mensaje no corresponde a su área, por favor reenvíelo a la persona de nómina o talento humano.</p>
      </td></tr>
    </table>
  </td></tr></table></body></html>`;
  const texto = [
    'Cordial saludo.', '',
    'La Cooperativa Progresemos recibió una solicitud de crédito de un colaborador de su empresa y requiere su autorización para descontar la cuota por nómina:', '',
    ...filas.map(([k, v]) => `${k}: ${v}`), '',
    `Por favor responda a este correo indicando si autoriza o no el descuento. Su respuesta llegará directamente al asesor ${asesor.nombre}.`, '',
    '— Cooperativa Progresemos',
  ].join('\n');
  return { asunto, html, texto };
};
