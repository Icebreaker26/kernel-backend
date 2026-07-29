import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { listar, perfil } from '../controllers/empresasController.js';

const router = Router();
router.use(verifyToken);

router.get('/',              checkPermission('empresas', 'READ'), listar);
router.get('/:codigo/perfil', checkPermission('empresas', 'READ'), perfil);

export default router;
