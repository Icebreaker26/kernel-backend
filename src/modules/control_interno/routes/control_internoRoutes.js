import { Router } from 'express';
import { verifyToken }     from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/controlInternoController.js';
import { listarUmbrales, crearUmbral, actualizarUmbral } from '../../tesoreria/controllers/tesoreriaController.js';

const router = Router();
router.use(verifyToken);

router.get('/facturas',                  checkPermission('control_interno', 'READ'),  ctrl.listarPendientes);
router.put('/facturas/:id/verificar',    checkPermission('control_interno', 'WRITE'), ctrl.aprobarFactura);
router.put('/facturas/:id/rechazar',     checkPermission('control_interno', 'WRITE'), ctrl.rechazarFactura);

// Alias para compatibilidad con tests existentes
router.put('/facturas/:id/aprobar',      checkPermission('control_interno', 'WRITE'), ctrl.aprobarFactura);

// ── Umbrales de aprobación ─────────────────────────────────────────────────
router.get('/config/umbrales',     checkPermission('control_interno', 'READ'),  listarUmbrales);
router.post('/config/umbrales',    checkPermission('control_interno', 'WRITE'), crearUmbral);
router.put('/config/umbrales/:id', checkPermission('control_interno', 'WRITE'), actualizarUmbral);

export default router;
