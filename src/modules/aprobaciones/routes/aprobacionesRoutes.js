import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import * as ctrl from '../controllers/aprobacionesController.js';

const router = Router();
router.use(verifyToken);

// Sin checkPermission — cualquier usuario autenticado puede ver sus pendientes
router.get('/',        ctrl.misFacturas);
router.get('/contar',  ctrl.contarPendientes);
router.put('/:id/aprobar', ctrl.aprobar);

export default router;
