import { Router } from 'express';
import { verifyToken }     from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/controlInternoController.js';
import { listarUmbrales, crearUmbral, actualizarUmbral } from '../../tesoreria/controllers/tesoreriaController.js';
import * as db from '../controllers/datosBancariosController.js';
import { descargarAdjunto } from '../../contable/controllers/adjuntoController.js';

const router = Router();
router.use(verifyToken);

router.get('/facturas',                  checkPermission('control_interno', 'READ'),  ctrl.listarPendientes);
router.get('/facturas/:id/adjunto',      checkPermission('control_interno', 'READ'),  descargarAdjunto);
router.put('/facturas/:id/verificar',    checkPermission('control_interno', 'WRITE'), ctrl.aprobarFactura);
router.put('/facturas/:id/rechazar',     checkPermission('control_interno', 'WRITE'), ctrl.rechazarFactura);

// Alias para compatibilidad con tests existentes
router.put('/facturas/:id/aprobar',      checkPermission('control_interno', 'WRITE'), ctrl.aprobarFactura);

// ── Datos bancarios de proveedores ─────────────────────────────────────────
router.get('/datos-bancarios',                    checkPermission('control_interno', 'READ'),  db.listarPendientes);
router.get('/datos-bancarios/:id/certificado',    checkPermission('control_interno', 'READ'),  db.verCertificado);
router.put('/datos-bancarios/:id/verificar',      checkPermission('control_interno', 'WRITE'), db.verificar);
router.put('/datos-bancarios/:id/rechazar',       checkPermission('control_interno', 'WRITE'), db.rechazar);

// ── Umbrales de aprobación ─────────────────────────────────────────────────
router.get('/config/umbrales',     checkPermission('control_interno', 'READ'),  listarUmbrales);
router.post('/config/umbrales',    checkPermission('control_interno', 'WRITE'), crearUmbral);
router.put('/config/umbrales/:id', checkPermission('control_interno', 'WRITE'), actualizarUmbral);

export default router;
