import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import * as ctrl from '../controllers/notificacionesController.js';

const router = Router();
router.use(verifyToken);

router.get('/',                    ctrl.listar);
router.patch('/:id/leer',          ctrl.marcarLeida);
router.patch('/leer-todas',        ctrl.marcarTodasLeidas);

export default router;
