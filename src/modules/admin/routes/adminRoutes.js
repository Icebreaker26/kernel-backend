import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/adminController.js';

const router = Router();
router.use(verifyToken);
router.use(checkPermission('admin', 'READ'));

router.get('/usuarios',                    ctrl.listarUsuarios);
router.get('/usuarios/:id/permisos',       ctrl.listarPermisosUsuario);
router.get('/modulos',                     ctrl.listarModulos);
router.patch('/usuarios/:id/aprobar',      checkPermission('admin', 'WRITE'), ctrl.aprobarUsuario);
router.patch('/usuarios/:id/desactivar',   checkPermission('admin', 'WRITE'), ctrl.desactivarUsuario);
router.patch('/usuarios/:id/rol',          checkPermission('admin', 'WRITE'), ctrl.cambiarRol);
router.post('/permisos/asignar-masivo',    checkPermission('admin', 'WRITE'), ctrl.asignarPermisosmasivo);

export default router;
