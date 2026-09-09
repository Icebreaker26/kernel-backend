import { Router } from 'express';
import { verifyToken }      from '../../../middlewares/auth.js';
import { checkPermission }  from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/tesoreriaController.js';

const router = Router();
router.use(verifyToken);

// ── Dashboard ──────────────────────────────────────────────────────────────────
router.get('/dashboard', checkPermission('tesoreria', 'READ'), ctrl.dashboard);

// ── Cuentas ────────────────────────────────────────────────────────────────────
router.get('/cuentas',      checkPermission('tesoreria', 'READ'),   ctrl.listarCuentas);
router.get('/cuentas/:id',  checkPermission('tesoreria', 'READ'),   ctrl.getCuenta);
router.post('/cuentas',     checkPermission('tesoreria', 'WRITE'),  ctrl.crearCuenta);
router.put('/cuentas/:id',  checkPermission('tesoreria', 'WRITE'),  ctrl.actualizarCuenta);

// ── Categorías ─────────────────────────────────────────────────────────────────
router.get('/categorias',      checkPermission('tesoreria', 'READ'),  ctrl.listarCategorias);
router.post('/categorias',     checkPermission('tesoreria', 'WRITE'), ctrl.crearCategoria);
router.put('/categorias/:id',  checkPermission('tesoreria', 'WRITE'), ctrl.actualizarCategoria);

// ── Períodos ───────────────────────────────────────────────────────────────────
router.get('/periodos',           checkPermission('tesoreria', 'READ'),   ctrl.listarPeriodos);
router.post('/periodos',          checkPermission('tesoreria', 'WRITE'),  ctrl.crearPeriodo);
router.put('/periodos/:id/cerrar', checkPermission('tesoreria', 'WRITE'), ctrl.cerrarPeriodo);

// ── Movimientos ────────────────────────────────────────────────────────────────
router.get('/movimientos',   checkPermission('tesoreria', 'READ'),   ctrl.listarMovimientos);
router.post('/movimientos',  checkPermission('tesoreria', 'WRITE'),  ctrl.crearMovimiento);

export default router;
