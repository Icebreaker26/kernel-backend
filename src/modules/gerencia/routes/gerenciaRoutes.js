import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { resumen, cobertura, lineas, lineaDetalle } from '../controllers/gerenciaController.js';

const router = Router();
router.use(verifyToken);

router.get('/resumen',               checkPermission('gerencia', 'READ'), resumen);
router.get('/cobertura/:sorteoId',   checkPermission('gerencia', 'READ'), cobertura);
router.get('/lineas',                checkPermission('gerencia', 'READ'), lineas);
router.get('/lineas/:lineaId',       checkPermission('gerencia', 'READ'), lineaDetalle);

export default router;
