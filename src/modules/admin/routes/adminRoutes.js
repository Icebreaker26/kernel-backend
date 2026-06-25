import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/adminController.js';
import { metricas } from '../controllers/dashboardController.js';

const router = Router();
router.use(verifyToken);
router.use(checkPermission('admin', 'READ'));

router.get('/metricas',                    metricas);
router.get('/usuarios',                    ctrl.listarUsuarios);
router.get('/usuarios/:id/permisos',       ctrl.listarPermisosUsuario);
router.get('/modulos',                     ctrl.listarModulos);
router.get('/logs',                        ctrl.listarAdminLogs);
router.patch('/usuarios/:id/aprobar',      checkPermission('admin', 'WRITE'), ctrl.aprobarUsuario);
router.patch('/usuarios/:id/desactivar',   checkPermission('admin', 'WRITE'), ctrl.desactivarUsuario);
router.patch('/usuarios/:id/reactivar',    checkPermission('admin', 'WRITE'), ctrl.reactivarUsuario);
router.patch('/usuarios/:id/rol',          checkPermission('admin', 'WRITE'), ctrl.cambiarRol);
router.patch('/usuarios/:id/password',          checkPermission('admin', 'WRITE'), ctrl.resetearPassword);
router.patch('/asociados/:codigo/password',     checkPermission('admin', 'WRITE'), ctrl.resetearPasswordAsociado);
router.post('/permisos/asignar-masivo',    checkPermission('admin', 'WRITE'), ctrl.asignarPermisosmasivo);

export default router;
