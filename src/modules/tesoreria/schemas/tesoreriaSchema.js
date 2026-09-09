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
  nombre:    z.string().min(1).optional(),
  entidad:   z.string().optional().or(z.literal('')),
  numero:    z.string().optional().or(z.literal('')),
  is_active: z.boolean().optional(),
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
  proveedor_id:      z.string().uuid(),
  monto:             z.preprocess((v) => Number(v), z.number().positive()),
  fecha_recibida:    z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  fecha_vencimiento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  descripcion:       z.string().optional().or(z.literal('')),
  soporte:           z.string().optional().or(z.literal('')),
  cuenta_pago_id:    uuidOpcional,
});

export const pagarFacturaSchema = z.object({
  cuenta_pago_id: z.string().uuid(),
  fecha_pago:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  referencia:     z.string().optional().or(z.literal('')),
  periodo_id:     uuidOpcional,
});

export const rechazarFacturaSchema = z.object({
  motivo: z.string().min(1),
});

export const crearMovimientoSchema = z.object({
  tipo:                  z.enum(['ingreso', 'egreso', 'traslado']),
  monto:                 z.preprocess((v) => Number(v), z.number().positive()),
  fecha:                 z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  descripcion:           z.string().optional().or(z.literal('')),
  referencia:            z.string().optional().or(z.literal('')),
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
