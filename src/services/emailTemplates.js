import { env } from '../config/env.js';

const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const portalUrl = () => env.PORTAL_URL ?? 'https://kernel.cooperativaprogresemos.coop/portal';

// ── Cabecera y pie compartidos ────────────────────────────────────────────────
const header = (titulo = '') => `
  <tr>
    <td style="background:#003d4d;padding:28px 32px;text-align:center;">
      <p style="margin:0;color:#7dd3e8;font-size:10px;letter-spacing:4px;font-family:Arial,sans-serif;">COOPERATIVA PROGRESEMOS</p>
      <h1 style="margin:8px 0 4px;color:#ffffff;font-size:26px;letter-spacing:4px;font-weight:700;font-family:Courier New,monospace;">KERNEL</h1>
      ${titulo ? `<p style="margin:0;color:#7dd3e8;font-size:11px;letter-spacing:3px;font-family:Arial,sans-serif;">${esc(titulo)}</p>` : ''}
    </td>
  </tr>`;

const footer = () => `
  <tr>
    <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:18px 32px;text-align:center;">
      <p style="margin:0;color:#94a3b8;font-size:11px;">&copy; Cooperativa Progresemos &middot; Sistema KERNEL</p>
      <p style="margin:4px 0 0;color:#cbd5e1;font-size:10px;">Correo generado automáticamente &mdash; por favor no responder</p>
    </td>
  </tr>`;

const wrapper = (asunto, bodyRows) => `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${esc(asunto)}</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f0f4f8;padding:32px 16px;">
    <tr><td align="center">
      <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
        style="max-width:580px;background:#ffffff;border-radius:8px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        ${bodyRows}
        ${footer()}
      </table>
    </td></tr>
  </table>
</body>
</html>`;

// ── Template: credenciales de portal (activación) ─────────────────────────────
export const buildCredencialesHtml = (codigo, password) => {
  const url = portalUrl() + '/login';
  const co  = esc(codigo);
  const pw  = esc(password);

  const body = `
    ${header('PORTAL DEL ASOCIADO')}
    <tr>
      <td style="padding:36px 32px 28px;">
        <p style="margin:0 0 8px;color:#1e293b;font-size:16px;font-weight:700;">¡Tu acceso está listo!</p>
        <p style="margin:0 0 28px;color:#475569;font-size:14px;line-height:1.7;">
          Tu cuenta en el Portal del Asociado de la Cooperativa Progresemos ha sido activada.
          A continuación encontrarás tus credenciales de ingreso.
        </p>

        <table width="100%" cellpadding="0" cellspacing="0" role="presentation"
          style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;margin-bottom:28px;">
          <tr>
            <td style="padding:22px 24px;">
              <p style="margin:0 0 16px;color:#64748b;font-size:10px;letter-spacing:3px;font-family:Arial,sans-serif;">TUS CREDENCIALES DE ACCESO</p>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:12px;">
                <tr>
                  <td style="padding:12px 16px;background:#ffffff;border:1px solid #e2e8f0;border-radius:5px;">
                    <p style="margin:0 0 3px;color:#94a3b8;font-size:10px;letter-spacing:1px;">USUARIO &mdash; NÚMERO DE CÉDULA</p>
                    <p style="margin:0;color:#1e293b;font-size:20px;font-family:Courier New,Courier,monospace;font-weight:700;letter-spacing:1px;">${co}</p>
                  </td>
                </tr>
              </table>
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td style="padding:14px 16px;background:#003d4d;border-radius:5px;">
                    <p style="margin:0 0 4px;color:#7dd3e8;font-size:10px;letter-spacing:1px;">CONTRASEÑA TEMPORAL</p>
                    <p style="margin:0;color:#ffffff;font-size:24px;font-family:Courier New,Courier,monospace;font-weight:700;letter-spacing:3px;word-break:break-all;">${pw}</p>
                    <p style="margin:6px 0 0;color:#7dd3e893;font-size:10px;">Haz clic o selecciona el texto para copiarlo</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:28px;">
          <tr>
            <td align="center">
              <a href="${url}" style="display:inline-block;background:#006680;color:#ffffff;text-decoration:none;padding:15px 40px;border-radius:5px;font-size:13px;font-weight:700;letter-spacing:2px;font-family:Arial,sans-serif;">
                INGRESAR AL PORTAL &rarr;
              </a>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding-top:10px;">
              <p style="margin:0;color:#94a3b8;font-size:11px;">
                O copia y pega este enlace en tu navegador:<br>
                <span style="color:#006680;font-size:11px;">${esc(url)}</span>
              </p>
            </td>
          </tr>
        </table>

        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-bottom:24px;">
          <tr>
            <td style="padding:14px 18px;background:#fffbeb;border:1px solid #fde68a;border-radius:6px;">
              <p style="margin:0;color:#92400e;font-size:13px;line-height:1.6;">
                <strong>&#9888; Importante:</strong> Al ingresar por primera vez se te pedirá que
                crees una contraseña personal. Esta contraseña temporal es de un solo uso —
                <strong>no la compartas con nadie</strong>.
              </p>
            </td>
          </tr>
        </table>

        <p style="margin:0;color:#94a3b8;font-size:12px;line-height:1.7;">
          Si tienes algún problema para ingresar, comunícate con la cooperativa.
        </p>
      </td>
    </tr>`;

  return wrapper('Tus credenciales de acceso — Portal Cooperativa Progresemos', body);
};

// ── Template: campaña de mailing ──────────────────────────────────────────────
// cuerpoHtml: fragmento HTML generado por plantillaHtml.js (frontend) o escrito a mano
export const buildCampanaHtml = (asunto, cuerpoHtml) => {
  const url = portalUrl();
  const body = `
    ${header()}
    <tr>
      <td style="padding:36px 32px 28px;color:#334155;font-size:15px;line-height:1.7;">
        ${cuerpoHtml}
      </td>
    </tr>
    <tr>
      <td align="center" style="padding:0 32px 32px;">
        <a href="${url}" style="display:inline-block;background:#006680;color:#ffffff;text-decoration:none;padding:13px 36px;border-radius:5px;font-size:13px;font-weight:700;letter-spacing:2px;">
          IR AL PORTAL &rarr;
        </a>
      </td>
    </tr>`;

  return wrapper(asunto, body);
};
