import { Router } from 'express';
import { verifyToken }     from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/controlInternoController.js';
import { listarUmbrales, crearUmbral, actualizarUmbral } from '../../tesoreria/controllers/tesoreriaController.js';
import * as db from '../controllers/datosBancariosController.js';
import { descargarAdjunto } from '../../contable/controllers/adjuntoController.js';
import * as creditosCI from '../controllers/creditosController.js';
import { costlyEndpointLimiter } from '../../../middlewares/rateLimiter.js';
import { lockdownFinanciero } from '../../../middlewares/lockdown.js';

const router = Router();
router.use(verifyToken);

// Un identificador mal formado no debe llegar a la base de datos: se responde 404
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
router.param('creditoId', (req, res, next, v) => (UUID.test(v) ? next() : res.status(404).json({ error: 'No encontrado' })));

router.get('/estadisticas',               costlyEndpointLimiter, checkPermission('control_interno', 'READ'),  ctrl.estadisticas);
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

// ── Créditos completados por Cartera (bandeja) ──────────────────────────────
router.get('/creditos',                       checkPermission('control_interno', 'READ'), creditosCI.listar);
const alias = (req, res, next) => { req.params.id = req.params.creditoId; next(); };
router.get('/creditos/:creditoId',             checkPermission('control_interno', 'READ'), alias, creditosCI.detalle);
router.get('/creditos/:creditoId/certificado', checkPermission('control_interno', 'READ'), alias, creditosCI.certificado);
router.post('/creditos/:creditoId/revision',   lockdownFinanciero, checkPermission('control_interno', 'REVISAR_CREDITOS'), alias, creditosCI.revisar);
router.get('/creditos/:creditoId/pdf-final',  checkPermission('control_interno', 'READ'), (req, res, next) => { req.params.id = req.params.creditoId; next(); }, creditosCI.pdfFinal);

// ── Umbrales de aprobación ─────────────────────────────────────────────────
router.get('/config/umbrales',     checkPermission('control_interno', 'READ'),         listarUmbrales);
// A-2: CONFIG_UMBRAL separa lectura de escritura para auditoría y restricción de rol
router.post('/config/umbrales',    checkPermission('control_interno', 'CONFIG_UMBRAL'),crearUmbral);
router.put('/config/umbrales/:id', checkPermission('control_interno', 'CONFIG_UMBRAL'),actualizarUmbral);

export default router;
