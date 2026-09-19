import crypto from 'crypto';
import pool from '../../../db/database.js';
import { notificarUsuario } from '../../../services/notificationService.js';
import { validarArchivo, generarPresignedUpload, guardarArchivo } from '../../../services/archivoService.js';
import {
  crearProspectoSchema, toqueSchema, updateProspectoSchema,
  seccionPersonalSchema, seccionLaboralSchema, seccionPepSchema,
  seccionFinancieraSchema, seccionBeneficiariosSchema, seccionReferenciasSchema,
  seccionFirmaSchema, stepUpSchema, valoresAsesorSchema,
} from '../schemas/captacionSchema.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');

const calcScore = `(
  CASE WHEN v.id IS NOT NULL AND v.seccion_firma_at IS NOT NULL THEN 40 ELSE 0 END +
  CASE WHEN v.id IS NOT NULL THEN 30 ELSE 0 END +
  CASE WHEN p.ping_count > 1 THEN 20 ELSE 0 END +
  CASE WHEN p.ping_at > NOW() - INTERVAL '2 hours' THEN 15 ELSE 0 END
) AS score`;

const VERSION_CONSENTIMIENTO = 'v1.0';

// ── CRUD interno (asesor) ─────────────────────────────────────────────────────

export const crearProspecto = async (req, res, next) => {
  try {
    const data = crearProspectoSchema.parse(req.body);

    // Validar empresa activa
    const { rowCount: emp } = await pool.query(
      `SELECT 1 FROM empresas WHERE codigo = $1 AND is_active = true`,
      [data.empresa_codigo]
    );
    if (!emp) return res.status(400).json({ error: 'Empresa no encontrada o inactiva' });

    // Duplicado: misma cédula activa (cualquier asesor, últimos 30 días)
    const { rows: dup } = await pool.query(
      `SELECT id, asesor_uuid FROM captacion_prospectos
        WHERE cedula = $1 AND is_active = true
          AND estado NOT IN ('convertido','convertido_por_sync','frio')
          AND created_at > NOW() - INTERVAL '30 days'`,
      [data.cedula]
    );
    if (dup.length) return res.status(409).json({ error: 'Ya existe un prospecto activo con esa cédula en los últimos 30 días' });

    // Generar token
    const rawToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(rawToken);

    const { rows: [p] } = await pool.query(
      `INSERT INTO captacion_prospectos
         (empresa_codigo, asesor_uuid, nombres, apellidos, cedula, celular, correo, token_hash, token)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING id, nombres, apellidos, cedula, celular, correo, empresa_codigo, estado, created_at`,
      [data.empresa_codigo, req.user.id, data.nombres, data.apellidos,
       data.cedula, data.celular, data.correo || null, tokenHash, rawToken]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, autor_uuid, ip)
       VALUES ($1, 'creado', 'asesor', $2, $3)`,
      [p.id, req.user.id, req.ip]
    );

    res.status(201).json({ ...p, token: rawToken });
  } catch (err) { next(err); }
};

export const listarProspectos = async (req, res, next) => {
  try {
    const { estado, empresa } = req.query;
    const params = [req.user.id];
    const filters = [`p.asesor_uuid = $1`, `p.is_active = true`];

    if (estado) { params.push(estado); filters.push(`p.estado = $${params.length}`); }
    if (empresa) { params.push(empresa); filters.push(`p.empresa_codigo = $${params.length}`); }

    const { rows } = await pool.query(
      `SELECT p.id, p.nombres, p.apellidos, p.cedula, p.celular, p.correo,
              p.empresa_codigo, e.nombre AS empresa_nombre,
              p.estado, p.ping_count, p.ping_at, p.created_at, p.convertido_at,
              v.id AS vinculacion_id, v.estado AS vinculacion_estado,
              v.seccion_personal_at, v.seccion_laboral_at, v.seccion_pep_at,
              v.seccion_financiera_at, v.seccion_beneficiarios_at,
              v.seccion_referencias_at, v.seccion_documentos_at, v.seccion_firma_at,
              (SELECT resultado FROM captacion_toques
                WHERE prospecto_id = p.id ORDER BY created_at DESC LIMIT 1) AS ultimo_toque,
              (SELECT created_at FROM captacion_toques
                WHERE prospecto_id = p.id ORDER BY created_at DESC LIMIT 1) AS ultimo_toque_at,
              ${calcScore}
         FROM captacion_prospectos p
         JOIN empresas e ON e.codigo = p.empresa_codigo
         LEFT JOIN captacion_vinculaciones v ON v.prospecto_id = p.id AND v.is_active = true
        WHERE ${filters.join(' AND ')}
        ORDER BY score DESC, p.ping_at DESC NULLS LAST, p.created_at DESC`,
      params
    );
    res.json(rows);
  } catch (err) { next(err); }
};

export const getProspecto = async (req, res, next) => {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT p.*, e.nombre AS empresa_nombre,
              v.id AS vinculacion_id, v.estado AS vinculacion_estado,
              v.seccion_personal_at, v.seccion_laboral_at, v.seccion_pep_at,
              v.seccion_financiera_at, v.seccion_beneficiarios_at,
              v.seccion_referencias_at, v.seccion_documentos_at, v.seccion_firma_at,
              v.seccion_personal_autor, v.seccion_laboral_autor,
              v.seccion_pep_autor, v.seccion_financiera_autor,
              v.debida_diligencia_ampliada
         FROM captacion_prospectos p
         JOIN empresas e ON e.codigo = p.empresa_codigo
         LEFT JOIN captacion_vinculaciones v ON v.prospecto_id = p.id AND v.is_active = true
        WHERE p.id = $1 AND p.asesor_uuid = $2 AND p.is_active = true`,
      [req.params.id, req.user.id]
    );
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });
    res.json(p);
  } catch (err) { next(err); }
};

export const actualizarProspecto = async (req, res, next) => {
  try {
    const data = updateProspectoSchema.parse(req.body);
    const sets = Object.entries(data).map(([k], i) => `${k} = $${i + 2}`);
    if (!sets.length) return res.status(400).json({ error: 'Nada que actualizar' });

    const { rows: [p] } = await pool.query(
      `UPDATE captacion_prospectos SET ${sets.join(', ')}, updated_at = NOW()
        WHERE id = $1 AND asesor_uuid = $${sets.length + 2} AND is_active = true
        RETURNING id, estado`,
      [req.params.id, ...Object.values(data), req.user.id]
    );
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });
    res.json(p);
  } catch (err) { next(err); }
};

export const registrarToque = async (req, res, next) => {
  try {
    const data = toqueSchema.parse(req.body);
    const { rows: [p] } = await pool.query(
      `SELECT id FROM captacion_prospectos WHERE id = $1 AND asesor_uuid = $2 AND is_active = true`,
      [req.params.id, req.user.id]
    );
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });

    const { rows: [t] } = await pool.query(
      `INSERT INTO captacion_toques (prospecto_id, asesor_uuid, resultado, notas)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [req.params.id, req.user.id, data.resultado, data.notas || null]
    );

    await pool.query(
      `UPDATE captacion_prospectos SET estado = 'contactado', updated_at = NOW()
        WHERE id = $1 AND estado = 'nuevo'`,
      [req.params.id]
    );

    res.status(201).json(t);
  } catch (err) { next(err); }
};

export const whatsappUrl = async (req, res, next) => {
  try {
    const { rows: [p] } = await pool.query(
      `SELECT p.nombres, p.apellidos, p.celular, p.token, p.estado,
              u.nombre AS asesor_nombre
         FROM captacion_prospectos p
         JOIN global_usuarios u ON u.id = p.asesor_uuid
        WHERE p.id = $1 AND p.asesor_uuid = $2 AND p.is_active = true`,
      [req.params.id, req.user.id]
    );
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });

    const baseUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    const link = `${baseUrl}/conocenos/${p.token}`;
    const telefono = p.celular.replace(/\D/g, '').replace(/^0/, '57');
    const mensaje = encodeURIComponent(
      `Hola ${p.nombres}, soy ${p.asesor_nombre} de Cooperativa Progresemos. ` +
      `Te comparto información sobre cómo afiliarte y los beneficios que tenemos para ti: ${link}`
    );
    const url = `https://wa.me/${telefono.startsWith('57') ? telefono : '57' + telefono}?text=${mensaje}`;

    await pool.query(
      `UPDATE captacion_prospectos SET estado = 'link_enviado', updated_at = NOW()
        WHERE id = $1 AND estado IN ('nuevo','contactado')`,
      [req.params.id]
    );

    res.json({ url, link });
  } catch (err) { next(err); }
};

// ── Vinculaciones (asesor completa secciones faltantes) ──────────────────────

export const listarVinculaciones = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT v.id, v.estado, v.created_at, v.updated_at,
              p.nombres, p.apellidos, p.cedula, p.celular, p.empresa_codigo,
              e.nombre AS empresa_nombre,
              v.seccion_personal_at, v.seccion_laboral_at, v.seccion_pep_at,
              v.seccion_financiera_at, v.seccion_beneficiarios_at,
              v.seccion_referencias_at, v.seccion_documentos_at, v.seccion_firma_at,
              v.debida_diligencia_ampliada, v.entregada_at
         FROM captacion_vinculaciones v
         JOIN captacion_prospectos p ON p.id = v.prospecto_id
         JOIN empresas e ON e.codigo = p.empresa_codigo
        WHERE p.asesor_uuid = $1 AND v.is_active = true
        ORDER BY v.updated_at DESC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (err) { next(err); }
};

export const getVinculacion = async (req, res, next) => {
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.*,
              p.nombres, p.apellidos, p.cedula, p.celular, p.correo, p.empresa_codigo,
              e.nombre AS empresa_nombre,
              json_agg(DISTINCT jsonb_build_object(
                'id',b.id,'orden',b.orden,'identificacion',b.identificacion,
                'nombres',b.nombres,'porcentaje',b.porcentaje,
                'fecha_nacimiento',b.fecha_nacimiento,'parentesco',b.parentesco
              )) FILTER (WHERE b.id IS NOT NULL) AS beneficiarios,
              json_agg(DISTINCT jsonb_build_object(
                'id',r.id,'tipo',r.tipo,'nombres',r.nombres,
                'telefono_fijo',r.telefono_fijo,'celular',r.celular
              )) FILTER (WHERE r.id IS NOT NULL) AS referencias
         FROM captacion_vinculaciones v
         JOIN captacion_prospectos p ON p.id = v.prospecto_id
         JOIN empresas e ON e.codigo = p.empresa_codigo
         LEFT JOIN captacion_beneficiarios b ON b.vinculacion_id = v.id
         LEFT JOIN captacion_referencias r ON r.vinculacion_id = v.id
        WHERE v.id = $1 AND p.asesor_uuid = $2 AND v.is_active = true
        GROUP BY v.id, p.nombres, p.apellidos, p.cedula, p.celular, p.correo,
                 p.empresa_codigo, e.nombre`,
      [req.params.id, req.user.id]
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    res.json(v);
  } catch (err) { next(err); }
};

export const actualizarValoresAsesor = async (req, res, next) => {
  try {
    const data = valoresAsesorSchema.parse(req.body);
    const { rows: [v] } = await pool.query(
      `UPDATE captacion_vinculaciones SET
         valor_aporte   = COALESCE($1, valor_aporte),
         cuota_admision = COALESCE($2, cuota_admision),
         updated_at     = NOW()
        WHERE id = $3
          AND (SELECT asesor_uuid FROM captacion_prospectos WHERE id = prospecto_id) = $4
          AND is_active = true
        RETURNING id, valor_aporte, cuota_admision`,
      [data.valor_aporte ?? null, data.cuota_admision ?? null, req.params.id, req.user.id]
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    res.json(v);
  } catch (err) { next(err); }
};

export const entregar = async (req, res, next) => {
  try {
    const { rows: [v] } = await pool.query(
      `SELECT v.id, v.estado,
              v.seccion_pep_at, v.seccion_firma_at, v.seccion_documentos_at
         FROM captacion_vinculaciones v
         JOIN captacion_prospectos p ON p.id = v.prospecto_id
        WHERE v.id = $1 AND p.asesor_uuid = $2 AND v.is_active = true`,
      [req.params.id, req.user.id]
    );
    if (!v) return res.status(404).json({ error: 'Vinculación no encontrada' });
    if (v.estado === 'entregada') return res.status(400).json({ error: 'Ya fue entregada' });
    if (!v.seccion_pep_at) return res.status(400).json({ error: 'Falta completar la sección PEP (SARLAFT)' });
    if (!v.seccion_firma_at) return res.status(400).json({ error: 'Falta la firma digital del asociado' });
    if (!v.seccion_documentos_at) return res.status(400).json({ error: 'Falta cargar la cédula' });

    const { rows: [updated] } = await pool.query(
      `UPDATE captacion_vinculaciones
          SET estado = 'entregada', entregada_at = NOW(), entregada_por = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, estado, entregada_at`,
      [req.user.id, req.params.id]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, autor_tipo, autor_uuid, ip)
       SELECT prospecto_id, $1, 'entregada', 'asesor', $2, $3
         FROM captacion_vinculaciones WHERE id = $1`,
      [req.params.id, req.user.id, req.ip]
    );

    res.json(updated);
  } catch (err) { next(err); }
};

// ── Endpoints públicos (sin auth — token como sesión) ─────────────────────────

const resolverToken = async (rawToken) => {
  const { rows: [p] } = await pool.query(
    `SELECT id, nombres, apellidos, cedula, celular, correo, empresa_codigo,
            estado, ping_count, token_expira_at, asesor_uuid
       FROM captacion_prospectos
      WHERE token = $1 AND is_active = true`,
    [rawToken]
  );
  return p || null;
};

export const pubGetProspecto = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido o expirado' });
    if (new Date(p.token_expira_at) < new Date()) return res.status(410).json({ error: 'Este link ha expirado' });

    // Devolver solo info pública + datos del asesor para WhatsApp flotante
    const { rows: [asesor] } = await pool.query(
      `SELECT nombre, avatar_url FROM global_usuarios WHERE id = $1`,
      [p.asesor_uuid]
    );

    const { rows: [v] } = await pool.query(
      `SELECT estado, seccion_personal_at, seccion_laboral_at, seccion_pep_at,
              seccion_financiera_at, seccion_beneficiarios_at, seccion_referencias_at,
              seccion_documentos_at, seccion_firma_at
         FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`,
      [p.id]
    );

    res.json({
      nombres: p.nombres,
      empresa_codigo: p.empresa_codigo,
      asesor: { nombre: asesor?.nombre, avatar_url: asesor?.avatar_url, celular: p.celular },
      version_consentimiento: VERSION_CONSENTIMIENTO,
      vinculacion: v || null,
    });
  } catch (err) { next(err); }
};

export const pubPing = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });

    await pool.query(
      `UPDATE captacion_prospectos
          SET ping_count = ping_count + 1, ping_at = NOW(),
              estado = CASE WHEN estado IN ('nuevo','link_enviado') THEN 'vio_landing' ELSE estado END,
              updated_at = NOW()
        WHERE id = $1`,
      [p.id]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, tipo, autor_tipo, ip, user_agent)
       VALUES ($1, 'ping', 'prospecto', $2, $3)`,
      [p.id, req.ip, req.headers['user-agent'] || null]
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
};

export const pubStepUp = async (req, res, next) => {
  try {
    const { digitos } = stepUpSchema.parse(req.body);
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });

    const ultimosCuatro = p.cedula.slice(-4);
    if (digitos !== ultimosCuatro) return res.status(403).json({ error: 'Verificación incorrecta' });

    res.json({ ok: true });
  } catch (err) { next(err); }
};

// Guardar sección (PUT idempotente)
const guardarSeccion = (seccion, schema, camposExtra) => async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (new Date(p.token_expira_at) < new Date()) return res.status(410).json({ error: 'Link expirado' });

    const data = schema.parse(req.body);

    // Asegurar que la vinculación exista (crea si no)
    let { rows: [v] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`,
      [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`,
        [p.id]
      );
      v = nv;
      await pool.query(
        `UPDATE captacion_prospectos SET estado = CASE WHEN estado = 'vio_landing' THEN 'interesado' ELSE estado END,
         updated_at = NOW() WHERE id = $1`,
        [p.id]
      );
    }

    // Construir SET dinámico con los campos de la sección
    const campos = { ...data, ...camposExtra(v.id) };
    const sets = Object.keys(campos).map((k, i) => `${k} = $${i + 2}`);
    await pool.query(
      `UPDATE captacion_vinculaciones SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $1`,
      [v.id, ...Object.values(campos)]
    );

    await pool.query(
      `INSERT INTO captacion_eventos
         (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, ip, user_agent)
       VALUES ($1,$2,'seccion_guardada',$3,'prospecto',$4,$5)`,
      [p.id, v.id, seccion, req.ip, req.headers['user-agent'] || null]
    );

    res.json({ ok: true, vinculacion_id: v.id });
  } catch (err) { next(err); }
};

export const pubSeccionPersonal = guardarSeccion('personal', seccionPersonalSchema, () => ({
  seccion_personal_at   : new Date().toISOString(),
  seccion_personal_autor: 'prospecto',
}));

export const pubSeccionLaboral = guardarSeccion('laboral', seccionLaboralSchema, () => ({
  seccion_laboral_at   : new Date().toISOString(),
  seccion_laboral_autor: 'prospecto',
}));

export const pubSeccionPep = guardarSeccion('pep', seccionPepSchema, (vid) => ({
  seccion_pep_at   : new Date().toISOString(),
  seccion_pep_autor: 'prospecto',
  debida_diligencia_ampliada: false, // se recalcula abajo
}));

// PEP tiene lógica especial: marcar debida_diligencia_ampliada
export const pubSeccionPepHandler = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });

    const data = seccionPepSchema.parse(req.body);
    const esAmpliada = data.pep_maneja_recursos_publicos || data.pep_reconocimiento_publico ||
                       data.pep_poder_publico || data.pep_vinculo_expuesto;

    let { rows: [v] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`,
      [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`, [p.id]
      );
      v = nv;
    }

    await pool.query(
      `UPDATE captacion_vinculaciones SET
         pep_maneja_recursos_publicos = $1, pep_reconocimiento_publico = $2,
         pep_poder_publico = $3, pep_vinculo_expuesto = $4,
         debida_diligencia_ampliada = $5,
         seccion_pep_at = NOW(), seccion_pep_autor = 'prospecto',
         updated_at = NOW()
       WHERE id = $6`,
      [data.pep_maneja_recursos_publicos, data.pep_reconocimiento_publico,
       data.pep_poder_publico, data.pep_vinculo_expuesto, esAmpliada, v.id]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, ip)
       VALUES ($1,$2,'seccion_guardada','pep','prospecto',$3)`,
      [p.id, v.id, req.ip]
    );

    res.json({ ok: true, debida_diligencia_ampliada: esAmpliada });
  } catch (err) { next(err); }
};

export const pubSeccionFinanciera = guardarSeccion('financiera', seccionFinancieraSchema, () => ({
  seccion_financiera_at   : new Date().toISOString(),
  seccion_financiera_autor: 'prospecto',
}));

export const pubSeccionBeneficiarios = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });

    const { beneficiarios } = seccionBeneficiariosSchema.parse(req.body);
    const total = beneficiarios.reduce((s, b) => s + b.porcentaje, 0);
    if (total !== 100) return res.status(400).json({ error: 'Los porcentajes de beneficiarios deben sumar 100%' });

    let { rows: [v] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`, [p.id]
      );
      v = nv;
    }

    await pool.query(`DELETE FROM captacion_beneficiarios WHERE vinculacion_id = $1`, [v.id]);
    for (const b of beneficiarios) {
      await pool.query(
        `INSERT INTO captacion_beneficiarios (vinculacion_id, orden, identificacion, nombres, porcentaje, fecha_nacimiento, parentesco)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [v.id, b.orden, b.identificacion || null, b.nombres, b.porcentaje, b.fecha_nacimiento || null, b.parentesco || null]
      );
    }

    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_beneficiarios_at = NOW(), updated_at = NOW() WHERE id = $1`, [v.id]
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
};

export const pubSeccionReferencias = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });

    const { referencias } = seccionReferenciasSchema.parse(req.body);

    let { rows: [v] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`, [p.id]
      );
      v = nv;
    }

    await pool.query(`DELETE FROM captacion_referencias WHERE vinculacion_id = $1`, [v.id]);
    for (const r of referencias) {
      await pool.query(
        `INSERT INTO captacion_referencias (vinculacion_id, tipo, nombres, telefono_fijo, celular)
         VALUES ($1,$2,$3,$4,$5)`,
        [v.id, r.tipo, r.nombres || null, r.telefono_fijo || null, r.celular || null]
      );
    }

    await pool.query(
      `UPDATE captacion_vinculaciones SET seccion_referencias_at = NOW(), updated_at = NOW() WHERE id = $1`, [v.id]
    );

    res.json({ ok: true });
  } catch (err) { next(err); }
};

export const pubFirmar = async (req, res, next) => {
  try {
    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });

    const data = seccionFirmaSchema.parse(req.body);

    const { rows: [v] } = await pool.query(
      `SELECT id, seccion_pep_at FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) return res.status(400).json({ error: 'No hay formulario iniciado' });
    if (!v.seccion_pep_at) return res.status(400).json({ error: 'Debe completar la sección PEP antes de firmar' });

    // Snapshot del estado actual para hash
    const { rows: [snap] } = await pool.query(
      `SELECT v.*, p.nombres, p.apellidos, p.cedula, p.empresa_codigo FROM captacion_vinculaciones v
        JOIN captacion_prospectos p ON p.id = v.prospecto_id WHERE v.id = $1`, [v.id]
    );
    const snapshotStr = JSON.stringify(snap);
    const docHash = crypto.createHash('sha256').update(snapshotStr).digest('hex');

    await pool.query(
      `UPDATE captacion_vinculaciones SET
         firma_png              = $1,
         firma_trazos           = $2,
         firma_at               = NOW(),
         firma_ip               = $3,
         firma_user_agent       = $4,
         firma_doc_hash         = $5,
         version_consentimiento = $6,
         formulario_snapshot    = $7,
         seccion_firma_at       = NOW(),
         estado                 = 'solicitud_completa',
         updated_at             = NOW()
       WHERE id = $8`,
      [data.firma_png, JSON.stringify(data.firma_trazos), req.ip,
       req.headers['user-agent'] || null, docHash, data.version_consentimiento,
       snapshotStr, v.id]
    );

    await pool.query(
      `UPDATE captacion_prospectos SET estado = 'convertido', convertido_at = NOW(), updated_at = NOW()
        WHERE id = $1`, [p.id]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, autor_tipo, ip, payload)
       VALUES ($1,$2,'firma','prospecto',$3,$4)`,
      [p.id, v.id, req.ip, JSON.stringify({ doc_hash: docHash, version: data.version_consentimiento })]
    );

    // Notificar al asesor
    await pool.query(
      `SELECT asesor_uuid FROM captacion_prospectos WHERE id = $1`, [p.id]
    ).then(({ rows: [pr] }) => {
      if (pr?.asesor_uuid) {
        notificarUsuario(pr.asesor_uuid, {
          tipo   : 'captacion',
          mensaje: `${p.nombres} ${p.apellidos} completó su solicitud de vinculación`,
          modulo : 'captacion',
        }).catch(() => {});
      }
    });

    res.json({ ok: true, estado: 'solicitud_completa' });
  } catch (err) { next(err); }
};

// ── Upload de cédula (presigned URL pattern) ──────────────────────────────────

const LADOS_CEDULA = ['frente', 'reverso'];

export const pubSolicitarUploadCedula = async (req, res, next) => {
  try {
    const { lado } = req.params;
    if (!LADOS_CEDULA.includes(lado))
      return res.status(400).json({ error: 'lado debe ser frente o reverso' });

    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });
    if (new Date(p.token_expira_at) < new Date()) return res.status(410).json({ error: 'Link expirado' });

    const error = validarArchivo(req.body);
    if (error) return res.status(400).json({ error });

    // Asegurar que la vinculación exista
    let { rows: [v] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) {
      const { rows: [nv] } = await pool.query(
        `INSERT INTO captacion_vinculaciones (prospecto_id) VALUES ($1) RETURNING id`, [p.id]
      );
      v = nv;
    }

    const result = await generarPresignedUpload(`captacion_cedula_${lado}`, v.id, req.body);
    res.json(result);
  } catch (err) { next(err); }
};

export const pubConfirmarUploadCedula = async (req, res, next) => {
  try {
    const { lado } = req.params;
    if (!LADOS_CEDULA.includes(lado))
      return res.status(400).json({ error: 'lado debe ser frente o reverso' });

    const p = await resolverToken(req.params.token);
    if (!p) return res.status(404).json({ error: 'Link no válido' });

    const { key, nombre, mime, size } = req.body;
    if (!key || !nombre) return res.status(400).json({ error: 'Faltan campos: key, nombre' });

    const { rows: [v] } = await pool.query(
      `SELECT id FROM captacion_vinculaciones WHERE prospecto_id = $1 AND is_active = true`, [p.id]
    );
    if (!v) return res.status(400).json({ error: 'No hay formulario iniciado' });

    if (!key.startsWith(`kernel/captacion_cedula_${lado}s/${v.id}/`))
      return res.status(400).json({ error: 'Key inválida para esta solicitud' });

    const archivo = await guardarArchivo(`captacion_cedula_${lado}`, v.id, { key, nombre, mime, size }, null);

    const columna = lado === 'frente' ? 'cedula_frente_id' : 'cedula_reverso_id';
    await pool.query(
      `UPDATE captacion_vinculaciones SET ${columna} = $1, updated_at = NOW() WHERE id = $2`,
      [archivo.id, v.id]
    );

    // Marcar sección documentos si ambos lados subidos
    await pool.query(
      `UPDATE captacion_vinculaciones
          SET seccion_documentos_at = NOW(), seccion_documentos_autor = 'prospecto',
              updated_at = NOW()
        WHERE id = $1 AND cedula_frente_id IS NOT NULL AND cedula_reverso_id IS NOT NULL
          AND seccion_documentos_at IS NULL`,
      [v.id]
    );

    await pool.query(
      `INSERT INTO captacion_eventos (prospecto_id, vinculacion_id, tipo, seccion, autor_tipo, ip)
       VALUES ($1,$2,'seccion_guardada','documentos','prospecto',$3)`,
      [p.id, v.id, req.ip]
    );

    res.json({ ok: true, archivo_id: archivo.id });
  } catch (err) { next(err); }
};

export const pubListarEmpresas = async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT codigo, nombre FROM empresas WHERE is_active = true ORDER BY nombre ASC`
    );
    res.json(rows);
  } catch (err) { next(err); }
};
