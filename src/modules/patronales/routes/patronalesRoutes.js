import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { verifyEmpresa } from '../../../middlewares/authEmpresa.js';
import * as ctrl from '../controllers/patronalesController.js';

const router = Router();

// ── Portal empresa (sin token de empleado) ─────────────────────────────────────
router.post('/portal/login',             ctrl.loginEmpresa);
router.post('/portal/logout',            verifyEmpresa, ctrl.logoutEmpresa);
router.get('/portal/me',                 verifyEmpresa, ctrl.meEmpresa);
router.put('/portal/cambiar-password',   verifyEmpresa, ctrl.cambiarPasswordEmpresa);
router.get('/portal/facturas',           verifyEmpresa, ctrl.misFacturas);

// ── Área de empleados ──────────────────────────────────────────────────────────
router.use(verifyToken);

router.get('/dashboard',                             checkPermission('patronales', 'READ'),   ctrl.dashboard);
router.post('/causar',                               checkPermission('patronales', 'WRITE'),  ctrl.causar);

router.get('/facturas',                              checkPermission('patronales', 'READ'),   ctrl.listarFacturas);
router.get('/facturas/:id',                          checkPermission('patronales', 'READ'),   ctrl.getFactura);
router.post('/facturas/:id/pago',                    checkPermission('patronales', 'WRITE'),  ctrl.registrarPago);
router.put('/facturas/:id/anular',                   checkPermission('patronales', 'WRITE'),  ctrl.anularFactura);

router.get('/empresas',                              checkPermission('patronales', 'READ'),   ctrl.listarEmpresas);
router.get('/empresas/:codigo',                      checkPermission('patronales', 'READ'),   ctrl.getEmpresa);
router.put('/empresas/:codigo/config',               checkPermission('patronales', 'WRITE'),  ctrl.updateConfigEmpresa);
router.post('/empresas/:codigo/portal',              checkPermission('patronales', 'WRITE'),  ctrl.activarPortalEmpresa);

router.get('/asociados/:codigo/aporte',              checkPermission('patronales', 'READ'),   ctrl.historialAporte);
router.put('/asociados/:codigo/aporte',              checkPermission('patronales', 'WRITE'),  ctrl.actualizarAporte);

export default router;
