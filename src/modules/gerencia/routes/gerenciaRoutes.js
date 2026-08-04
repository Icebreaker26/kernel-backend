import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { resumen, cobertura } from '../controllers/gerenciaController.js';

const router = Router();
router.use(verifyToken);

router.get('/resumen',           checkPermission('gerencia', 'READ'), resumen);
router.get('/cobertura/:sorteoId', checkPermission('gerencia', 'READ'), cobertura);

export default router;
