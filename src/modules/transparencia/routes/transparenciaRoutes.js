import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { paginaPublicaLimiter } from '../../../middlewares/rateLimiter.js';
import * as ctrl from '../controllers/transparenciaController.js';

const router = Router();

// Público: la página /transparencia del sitio
router.get('/pub',                paginaPublicaLimiter, ctrl.pubListar);
router.get('/pub/:id/descargar',  paginaPublicaLimiter, ctrl.pubDescargar);

router.use(verifyToken);

router.get   ('/',                       checkPermission('transparencia', 'READ'),   ctrl.listar);
router.post  ('/',                       checkPermission('transparencia', 'WRITE'),  ctrl.crear);
router.put   ('/:id',                    checkPermission('transparencia', 'WRITE'),  ctrl.actualizar);
router.delete('/:id',                    checkPermission('transparencia', 'DELETE'), ctrl.eliminar);
router.post  ('/:id/archivo/solicitar',  checkPermission('transparencia', 'WRITE'),  ctrl.solicitarArchivo);
router.patch ('/:id/archivo/confirmar',  checkPermission('transparencia', 'WRITE'),  ctrl.confirmarArchivo);

export default router;
