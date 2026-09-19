import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/aprobacionesController.js';

const router = Router();
router.use(verifyToken);

router.get('/',                                                     ctrl.misFacturas);
router.get('/contar',                                               ctrl.contarPendientes);
router.get('/historial',                                            ctrl.historial);
router.get('/usuarios',                                             ctrl.listarUsuarios);
router.get('/:id',                                                  ctrl.getDetalle);
router.get('/:id/adjunto',                                          ctrl.verAdjunto);
router.put('/:id/aprobar',                                          ctrl.aprobar);
router.put('/:id/rechazar',                                         ctrl.rechazar);

export default router;
