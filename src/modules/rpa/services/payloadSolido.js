/**
 * Arma lo que el agente digita en SOLIDO (formulario "Mantenimiento Asociados") a partir de una vinculación de Kernel.
 *
 * Función pura: no toca la base de datos. Recibe los datos ya cargados y una función `eq(catalogo, texto)` que devuelve el
 * código de SOLIDO (o null). Devuelve el payload y la lista de `faltantes`: datos obligatorios que no hay o textos sin
 * equivalencia. Un job con faltantes NO se entrega al agente.
 *
 * Reglas fijas de la cooperativa (dadas por el usuario 2026-09-25):
 *  Página 1: Tipo de correo EXTERNO · CIIU 10 · País de nacimiento 54 · Clase ASOCIADO · Asesor = cédula del dueño de la
 *            vinculación · Grupo étnico NINGUNO · Factura NO · Dirección de envío = email
 *            Empresa = equivalencia de la empresa de Kernel (Clase Dscto Nómina) o, si no hay, 0010 Particulares (Clase Dscto Caja)
 *            Ciudad de envío y, en la Página 2, Profesión y Cargo: NO se tocan (quedan en 9999/999999, como en el asociado de referencia)
 *  Página 2: Tipo salario "2- ley 50" · Código interno = cédula · Jornada laboral Total · Dirección de envío = Casa
 *  Página 3: solo Egresos y Deudas (a terceros)
 *  Página 4: Segmento 001
 *
 * Los valores que vienen de Kernel se mandan neutros (p. ej. genero 'M', estado_civil 'soltero'): es el agente quien los
 * traduce al ítem de la lista de SOLIDO. Los valores de las reglas fijas se mandan tal cual se digitan.
 */

export const REGLAS_FIJAS = Object.freeze({
  tipo_correo: 'EXTERNO',
  nat_juridica: 'Natural',        // combo Natjur (1= Natural. / 2= Juridica.); SOLIDO lo deja en Juridica por defecto y los asociados son personas
  ciiu: '10',
  pais_nacimiento: '54',
  pais_residencia: '54',          // SOLIDO lo exige al guardar ("Código de país de residencia no existe o esta vacío"); Colombia
  clase: 'ASOCIADO',
  clase_dscto_nomina: 'Nomina',   // TODAS las empresas descuentan por nómina...
  clase_dscto_caja: 'Caja',       // ...menos Particulares (0010), que es por caja
  empresa_defecto: '0010',        // 0010 = PARTICULARES CIA 10 (sin empresa en la solicitud)
  grupo_etnico: 'NINGUNO',
  factura: 'NO',
  direccion_envio: 'email',
  tipo_salario: '2- ley 50',
  jornada_laboral: 'Total',
  direccion_envio_p2: 'Casa',
  segmento: '001',
});

// Minúsculas, sin tildes, espacios colapsados: es la llave con la que se buscan las equivalencias
export const norm = (s) => String(s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim();

// SOLIDO guarda en mayúsculas; se conserva la Ñ
export const mayus = (s) => String(s ?? '').trim().replace(/\s+/g, ' ')
  .replace(/[ñÑ]/g, '\u0001').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toUpperCase().replace(/\u0001/g, 'Ñ');

// Código de empresa de Kernel → código de SOLIDO: los numéricos van a 4 dígitos (10 → 0010, 138 → 0138); otros, tal cual
export const codigoSolido = (c) => (/^\d{1,4}$/.test(String(c).trim()) ? String(c).trim().padStart(4, '0') : String(c).trim());

// Llave de una ciudad: "ciudad|departamento" (más precisa) o solo "ciudad"
export const llaveCiudad = (ciudad, departamento) => (departamento ? `${norm(ciudad)}|${norm(departamento)}` : norm(ciudad));

const fecha = (d) => {
  if (!d) return null;
  if (typeof d === 'string') return d.slice(0, 10);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};

const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const vacio = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');

const PERIODO = { mensual: 'Mensual', quincenal: 'Quincenal' };

/**
 * @param {object} d
 * @param {object} d.v          fila de captacion_vinculaciones
 * @param {object} d.p          fila de captacion_prospectos (cédula, nombres, celular, correo…)
 * @param {string|null} d.asesorCedula   global_usuarios.cedula del asesor dueño
 * @param {(catalogo:string, texto:string, depto?:string)=>string|null} d.eq
 * @param {string} [d.hoy]      AAAA-MM-DD (por defecto, hoy)
 */
export const construirPayload = ({ v, p, asesorCedula, eq, hoy = fecha(new Date()) }) => {
  const faltantes = [];
  const falta = (campo, motivo, extra = {}) => faltantes.push({ campo, motivo, ...extra });

  const requerido = (campo, valor) => {
    if (vacio(valor)) { falta(campo, 'dato_faltante'); return null; }
    return valor;
  };

  // Código de catálogo: si no hay texto → dato faltante; si hay texto pero sin equivalencia → sin_equivalencia
  const codigo = (campo, catalogo, texto, depto, { obligatorio = true } = {}) => {
    if (vacio(texto)) { if (obligatorio) falta(campo, 'dato_faltante'); return null; }
    const c = eq(catalogo, texto, depto);
    if (!c) {
      if (obligatorio) falta(campo, 'sin_equivalencia', { catalogo, texto: String(texto), departamento: depto || null });
      return null;
    }
    return c;
  };

  const cedula = String(p.cedula ?? '').trim();
  if (!/^\d{4,15}$/.test(cedula)) falta('cedula', 'dato_faltante');

  const correo = requerido('email', p.correo?.trim().toLowerCase());
  const pasivos = num(v.total_pasivos);

  const pagina1 = {
    direccion: requerido('direccion', mayus(v.direccion_residencia)),
    ciudad: codigo('ciudad', 'ciudad', v.ciudad_residencia, v.departamento_residencia),
    ciudad_envio: null, // no se toca: queda en 999999 como en el asociado de referencia
    telefono1: requerido('telefono1', p.celular),
    telefono2: v.telefono_fijo || null,
    celular: p.celular || null,
    email: correo,
    genero: requerido('genero', v.genero),
    grupo_etnico: REGLAS_FIJAS.grupo_etnico,
    fecha_nacimiento: requerido('fecha_nacimiento', fecha(v.fecha_nacimiento)),
    nro_cedula: cedula,
    tipo_id: requerido('tipo_id', v.tipo_documento),
    fecha_expedicion: requerido('fecha_expedicion', fecha(v.fecha_expedicion)),
    expedida: requerido('expedida', mayus(v.ciudad_expedicion)),
    estado_civil: v.estado_civil || null,
    factura: REGLAS_FIJAS.factura,
    direccion_envio: REGLAS_FIJAS.direccion_envio,
    tipo_correo: REGLAS_FIJAS.tipo_correo,
    nat_juridica: REGLAS_FIJAS.nat_juridica,
    ciiu: REGLAS_FIJAS.ciiu,
    ciudad_nacimiento: codigo('ciudad_nacimiento', 'ciudad', v.ciudad_nacimiento, v.departamento_nacimiento),
    pais_nacimiento: REGLAS_FIJAS.pais_nacimiento,
    pais_residencia: REGLAS_FIJAS.pais_residencia,
    estrato: v.estrato ?? null,
    nivel_academico: v.nivel_academico || null,
    cabeza_de_familia: v.cabeza_de_hogar ?? null,
    persona_declarante: v.declarante_de_renta ?? null,
    persona_publica_expuesta: v.pep_reconocimiento_publico ?? null,
    administra_recursos_publicos: v.pep_maneja_recursos_publicos ?? v.maneja_recursos_publicos ?? null,
    // Datos de ingreso
    fecha_ingreso: hoy,
    periodo_dcto: PERIODO[v.periodicidad_descuento] ?? requerido('periodo_dcto', null) ?? null,
    clase_dscto: null,   // se define abajo según la empresa
    clase: REGLAS_FIJAS.clase,
    activos: num(v.total_activos) ?? 0,
    empresa: null,       // se define abajo
    asesor: requerido('asesor', asesorCedula),
  };
  // Empresa: el código de la empresa de Kernel ES el de SOLIDO (la tabla `empresas` viene de SOLIDO, sin ceros a la izquierda; SOLIDO los
  // muestra a 4 dígitos: 10 → 0010). Una equivalencia manual (`rpa_equivalencias`) sigue teniendo prioridad por si alguna difiere.
  // Sin empresa en la solicitud → 0010 Particulares. Descuento: por Caja SOLO en 0010 Particulares; en todas las demás, por Nómina.
  const codigoKernel = vacio(p.empresa_codigo) ? null : String(p.empresa_codigo).trim();
  const empresaEq = codigoKernel ? eq('empresa', codigoKernel) : null;
  const empresaCatalogo = codigoKernel && !empresaEq ? codigoSolido(codigoKernel) : null;
  pagina1.empresa = empresaEq ?? empresaCatalogo ?? REGLAS_FIJAS.empresa_defecto;
  pagina1.clase_dscto = codigoSolido(pagina1.empresa) === REGLAS_FIJAS.empresa_defecto ? REGLAS_FIJAS.clase_dscto_caja : REGLAS_FIJAS.clase_dscto_nomina;

  const pagina2 = {
    empresa: mayus(p.empresa_nombre ?? p.empresa_codigo) || null,
    fecha_ing: fecha(v.fecha_ingreso),
    salario: requerido('salario', num(v.ingresos_mensuales)),
    tipo_salario: REGLAS_FIJAS.tipo_salario,
    pasivos: pasivos ?? 0,
    otros_ingresos: num(v.otros_ingresos),
    descripcion_otros_ingresos: v.otros_ingresos_desc || null,
    profesion: null,     // no se toca: queda en 9999 como en el asociado de referencia
    cargo: null,
    ciudad: vacio(v.ciudad_trabajo)
      ? pagina1.ciudad                                        // sin ciudad de trabajo se usa la de residencia (como el asociado de referencia)
      : codigo('ciudad_trabajo', 'ciudad', v.ciudad_trabajo, v.departamento_trabajo),
    codigo_interno: cedula,
    jornada_laboral: REGLAS_FIJAS.jornada_laboral,
    direccion_envio: REGLAS_FIJAS.direccion_envio_p2,
  };

  // Página 3: solo Egresos y Deudas (a terceros)
  const pagina3 = {
    egresos: num(v.egresos_mensuales),
    deudas_terceros: pasivos,
  };

  const pagina4 = { segmento: REGLAS_FIJAS.segmento };

  // Para quien revisa la captura antes de aprobar; el agente no lo digita
  const informativo = {
    valor_aporte: num(v.valor_aporte),
    periodicidad_descuento: v.periodicidad_descuento ?? null,
    seguro_vida: v.seguro_vida_activo ?? null,
    bono_sorteo: v.bono_sorteo_activo ?? null,
    firmada_at: v.firma_at ? new Date(v.firma_at).toISOString() : null,
    // Para quien aprueba: si la empresa quedó por defecto (0010 Particulares / Caja) conviene revisar que no falte una equivalencia
    empresa_origen: empresaEq ? 'equivalencia' : (empresaCatalogo ? 'catalogo' : 'por_defecto'),
    empresa_kernel: p.empresa_nombre ?? p.empresa_codigo ?? null,
  };

  return {
    payload: {
      cabecera: { codigo: cedula, apellido: mayus(p.apellidos), nombre: mayus(p.nombres) },
      pagina1, pagina2, pagina3, pagina4, informativo,
    },
    faltantes,
  };
};
