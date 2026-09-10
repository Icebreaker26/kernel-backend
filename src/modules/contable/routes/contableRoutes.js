import { Router } from 'express';
import { verifyToken }     from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import {
  listarFacturas, getFactura, crearFactura, reenviarFactura,
  listarProveedores, crearProveedor, actualizarProveedor, perfilProveedor,
  listarCategorias, crearCategoria, actualizarCategoria,
  listarPeriodos, crearPeriodo, cerrarPeriodo,
} from '../../tesoreria/controllers/tesoreriaController.js';
import { getEstado, solicitarCambio } from '../../control_interno/controllers/datosBancariosController.js';

const router = Router();
router.use(verifyToken);

// ── Facturas ───────────────────────────────────────────────────────────────────
router.get('/facturas',                checkPermission('contable', 'READ'),  listarFacturas);
router.get('/facturas/:id',            checkPermission('contable', 'READ'),  getFactura);
router.post('/facturas',               checkPermission('contable', 'WRITE'), crearFactura);
router.put('/facturas/:id/reenviar',   checkPermission('contable', 'WRITE'), reenviarFactura);

// ── Proveedores (lectura + gestión desde Contable) ─────────────────────────────
router.get('/proveedores',                        checkPermission('contable', 'READ'),  listarProveedores);
router.get('/proveedores/:id/perfil',             checkPermission('contable', 'READ'),  perfilProveedor);
router.get('/proveedores/:id/datos-bancarios',    checkPermission('contable', 'READ'),  getEstado);
router.post('/proveedores/:id/datos-bancarios',   checkPermission('contable', 'WRITE'), solicitarCambio);
router.post('/proveedores',                       checkPermission('contable', 'WRITE'), crearProveedor);
router.put('/proveedores/:id',                    checkPermission('contable', 'WRITE'), actualizarProveedor);

// ── Categorías ─────────────────────────────────────────────────────────────────
router.get('/categorias',     checkPermission('contable', 'READ'),  listarCategorias);
router.post('/categorias',    checkPermission('contable', 'WRITE'), crearCategoria);
router.put('/categorias/:id', checkPermission('contable', 'WRITE'), actualizarCategoria);

// ── Períodos ───────────────────────────────────────────────────────────────────
router.get('/periodos',              checkPermission('contable', 'READ'),  listarPeriodos);
router.post('/periodos',             checkPermission('contable', 'WRITE'), crearPeriodo);
router.put('/periodos/:id/cerrar',   checkPermission('contable', 'WRITE'), cerrarPeriodo);

export default router;
