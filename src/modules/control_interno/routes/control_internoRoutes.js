import { Router } from 'express';
import { verifyToken }     from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/controlInternoController.js';

const router = Router();
router.use(verifyToken);

router.get('/facturas',                  checkPermission('control_interno', 'READ'),  ctrl.listarPendientes);
router.put('/facturas/:id/verificar',    checkPermission('control_interno', 'WRITE'), ctrl.aprobarFactura);
router.put('/facturas/:id/rechazar',     checkPermission('control_interno', 'WRITE'), ctrl.rechazarFactura);

// Alias para compatibilidad con tests existentes
router.put('/facturas/:id/aprobar',      checkPermission('control_interno', 'WRITE'), ctrl.aprobarFactura);

export default router;
