import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { listar } from '../controllers/empresasController.js';

const router = Router();
router.use(verifyToken);

router.get('/', checkPermission('empresas', 'READ'), listar);

export default router;
