import { z } from 'zod';

// ── Cuentas ────────────────────────────────────────────────────────────────────

export const crearCuentaSchema = z.object({
  nombre:        z.string().min(1),
  tipo:          z.enum(['banco', 'caja', 'tarjeta']),
  entidad:       z.string().optional().or(z.literal('')),
  numero:        z.string().optional().or(z.literal('')),
  saldo_inicial: z.preprocess((v) => Number(v), z.number().min(0)).default(0),
  moneda:        z.string().length(3).default('COP'),
});

export const actualizarCuentaSchema = z.object({
  nombre:  z.string().min(1).optional(),
  entidad: z.string().optional().or(z.literal('')),
  numero:  z.string().optional().or(z.literal('')),
}).strict();

export const desactivarCuentaSchema = z.object({
  confirmar: z.literal(true, { errorMap: () => ({ message: 'Debe confirmar explícitamente con confirmar: true' }) }),
  motivo:    z.string().min(10, 'El motivo debe tener al menos 10 caracteres'),
}).strict();

// ── Categorías ─────────────────────────────────────────────────────────────────

export const crearCategoriaSchema = z.object({
  nombre: z.string().min(1),
  tipo:   z.enum(['ingreso', 'egreso', 'traslado']),
  color:  z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
});

export const actualizarCategoriaSchema = z.object({
  nombre:    z.string().min(1).optional(),
  color:     z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  is_active: z.boolean().optional(),
}).strict();

// ── Períodos ───────────────────────────────────────────────────────────────────

export const crearPeriodoSchema = z.object({
  nombre:       z.string().min(1),
  fecha_inicio: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_fin:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

// ── Movimientos ────────────────────────────────────────────────────────────────

const uuidOpcional = z.string().uuid().nullable().optional().or(z.literal(''));

// ── Proveedores ────────────────────────────────────────────────────────────────

export const crearProveedorSchema = z.object({
  nombre:     z.string().min(1),
  nit:        z.string().optional().or(z.literal('')),
  email:      z.string().email().optional().or(z.literal('')),
  telefono:   z.string().optional().or(z.literal('')),
  tipo_pago:  z.enum(['recurrente', 'unico']),
  frecuencia: z.enum(['mensual', 'bimestral', 'trimestral', 'semestral', 'anual']).optional().or(z.literal('')),
  categoria:  z.string().optional().or(z.literal('')),
  notas:      z.string().optional().or(z.literal('')),
}).superRefine((data, ctx) => {
  if (data.tipo_pago === 'recurrente' && (!data.frecuencia || data.frecuencia === '')) {
    ctx.addIssue({ code: 'custom', path: ['frecuencia'], message: 'Requerida para proveedores recurrentes' });
  }
  if (data.tipo_pago === 'unico' && data.frecuencia && data.frecuencia !== '') {
    ctx.addIssue({ code: 'custom', path: ['frecuencia'], message: 'No aplica para pagos únicos' });
  }
});

export const actualizarProveedorSchema = z.object({
  nombre:    z.string().min(1).optional(),
  nit:       z.string().optional().or(z.literal('')),
  email:     z.string().email().optional().or(z.literal('')),
  telefono:  z.string().optional().or(z.literal('')),
  frecuencia: z.enum(['mensual', 'bimestral', 'trimestral', 'semestral', 'anual']).optional().or(z.literal('')),
  categoria: z.string().optional().or(z.literal('')),
  notas:     z.string().optional().or(z.literal('')),
  is_active: z.boolean().optional(),
}).strict();

// ── Facturas ───────────────────────────────────────────────────────────────────

export const crearFacturaSchema = z.object({
  proveedor_id:       z.string().uuid(),
  monto:              z.preprocess((v) => Number(v), z.number().positive()),
  fecha_emision:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  fecha_recibida:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_vencimiento:  z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  area_responsable:   z.string().optional().or(z.literal('')),
  fecha_entrega_area: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
  descripcion:        z.string().optional().or(z.literal('')),
  numero_factura:     z.string().optional().or(z.literal('')),
  cuenta_pago_id:     uuidOpcional,
  retencion_fuente:   z.preprocess((v) => Number(v), z.number().min(0)).default(0),
  retencion_ica:      z.preprocess((v) => Number(v), z.number().min(0)).default(0),
  retencion_iva:      z.preprocess((v) => Number(v), z.number().min(0)).default(0),
}).superRefine((d, ctx) => {
  const total = d.retencion_fuente + d.retencion_ica + d.retencion_iva;
  if (total >= d.monto) {
    ctx.addIssue({ code: 'custom', path: ['retencion_fuente'], message: 'Las retenciones no pueden superar el monto de la factura' });
  }
});

// Autorizar pago: marca la factura lista para pagar, sin reservar cuenta ni fecha.
// El vínculo con la transacción bancaria ocurre al subir el extracto XLS.
export const autorizarPagoSchema = z.object({}).strict();

// Conciliación manual: vincula movimientos ya importados con facturas pendientes
export const conciliarSchema = z.object({
  vinculos: z.array(z.object({
    factura_id:    z.string().uuid(),
    movimiento_id: z.string().uuid(),
  })).min(1, 'Debe incluir al menos un vínculo'),
});

export const rechazarFacturaSchema = z.object({
  motivo: z.string().min(1),
});

// ── Umbrales de aprobación ─────────────────────────────────────────────────────

export const crearUmbralSchema = z.object({
  tipo_operacion:   z.string().min(1),
  monto_umbral:     z.preprocess((v) => Number(v), z.number().positive()),
  descripcion:      z.string().optional().or(z.literal('')),
  dias_vencimiento: z.preprocess((v) => Number(v), z.number().int().min(1)).default(7),
});

export const actualizarUmbralSchema = z.object({
  monto_umbral:     z.preprocess((v) => Number(v), z.number().positive()).optional(),
  descripcion:      z.string().optional().or(z.literal('')),
  dias_vencimiento: z.preprocess((v) => Number(v), z.number().int().min(1)).optional(),
}).strict();

// ── Ingesta de extracto bancario ───────────────────────────────────────────────

export const confirmarExtractoSchema = z.object({
  cuenta_id:    z.string().uuid(),
  periodo_id:   z.string().uuid().nullable().optional().or(z.literal('')),
  categoria_id: z.string().uuid().nullable().optional().or(z.literal('')),
  referencias:  z.array(z.string().min(1)).min(1, 'Debe seleccionar al menos una transacción'),
  // Vínculos factura ↔ transacción: [{referencia_bancaria, factura_id}]
  vinculos:     z.array(z.object({
    referencia_bancaria: z.string().min(1),
    factura_id:          z.string().uuid(),
  })).optional().default([]),
});

// ── Movimientos ────────────────────────────────────────────────────────────────

export const crearMovimientoSchema = z.object({
  tipo:                  z.enum(['ingreso', 'egreso', 'traslado']),
  monto:                 z.preprocess((v) => Number(v), z.number().positive()),
  fecha:                 z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  descripcion:           z.string().optional().or(z.literal('')),
  referencia:            z.string().optional().or(z.literal('')),
  tercero_nombre:        z.string().max(200).optional().or(z.literal('')),
  cuenta_id:             z.string().uuid(),
  cuenta_destino_id:     uuidOpcional,
  categoria_id:          uuidOpcional,
  periodo_id:            uuidOpcional,
  corrige_movimiento_id: uuidOpcional,
}).superRefine((data, ctx) => {
  if (data.tipo === 'traslado' && (!data.cuenta_destino_id || data.cuenta_destino_id === '')) {
    ctx.addIssue({ code: 'custom', path: ['cuenta_destino_id'], message: 'Requerido para traslados' });
  }
  if (data.tipo === 'traslado' && data.cuenta_destino_id && data.cuenta_id === data.cuenta_destino_id) {
    ctx.addIssue({ code: 'custom', path: ['cuenta_destino_id'], message: 'Origen y destino deben ser distintos' });
  }
});
