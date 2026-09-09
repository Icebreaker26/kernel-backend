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

export const crearMovimientoSchema = z.object({
  tipo:                  z.enum(['ingreso', 'egreso', 'traslado']),
  monto:                 z.preprocess((v) => Number(v), z.number().positive()),
  fecha:                 z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  descripcion:           z.string().optional().or(z.literal('')),
  referencia:            z.string().optional().or(z.literal('')),
  cuenta_id:             z.string().uuid(),
  cuenta_destino_id:     z.string().uuid().nullable().optional(),
  categoria_id:          z.string().uuid().nullable().optional(),
  periodo_id:            z.string().uuid().nullable().optional(),
  corrige_movimiento_id: z.string().uuid().nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.tipo === 'traslado' && !data.cuenta_destino_id) {
    ctx.addIssue({ code: 'custom', path: ['cuenta_destino_id'], message: 'Requerido para traslados' });
  }
  if (data.tipo === 'traslado' && data.cuenta_id === data.cuenta_destino_id) {
    ctx.addIssue({ code: 'custom', path: ['cuenta_destino_id'], message: 'Origen y destino deben ser distintos' });
  }
});
