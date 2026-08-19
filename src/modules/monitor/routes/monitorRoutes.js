import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/monitorController.js';

const router = Router();
router.use(verifyToken);

router.get('/metricas',     checkPermission('monitor', 'READ'), ctrl.metricas);
router.get('/ingresos',     checkPermission('monitor', 'READ'), ctrl.ingresos);
router.get('/emails',       checkPermission('monitor', 'READ'), ctrl.emails);
router.get('/relay-status', checkPermission('monitor', 'READ'), ctrl.relayStatus);

export default router;
