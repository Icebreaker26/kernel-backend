import { Router } from 'express';
import multer from 'multer';
import { verifyToken } from '../../../middlewares/auth.js';
import { verifyAsociado } from '../../../middlewares/authAsociado.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { loginRateLimiter, solicitarPortalLimiter } from '../../../middlewares/rateLimiter.js';
import * as ctrl from '../controllers/asociadosController.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// ── Público: solicitud y registro de acceso ───────────────────────────────────
router.post('/solicitar-portal', solicitarPortalLimiter, ctrl.solicitarPortal);
router.post('/registro-portal',  solicitarPortalLimiter, ctrl.registroPortal);

// ── Portal del asociado ───────────────────────────────────────────────────────
router.post('/login',  loginRateLimiter, ctrl.loginAsociado);
router.post('/logout', ctrl.logoutAsociado);
router.get ('/me',                         verifyAsociado, ctrl.meAsociado);
router.get ('/descuentos',                 verifyAsociado, ctrl.descuentosPortal);
router.post('/aceptar-terminos',           verifyAsociado, ctrl.aceptarTerminos);
router.put ('/password',                   verifyAsociado, ctrl.cambiarPasswordAsociado);
router.put ('/email',                      verifyAsociado, ctrl.guardarEmail);
router.get ('/notificaciones',             verifyAsociado, ctrl.listarNotificaciones);
router.patch('/notificaciones/leer-todas', verifyAsociado, ctrl.marcarTodasNotifsLeidas);
router.patch('/notificaciones/:id/leer',   verifyAsociado, ctrl.marcarNotifLeida);

// ── Administración (staff con permiso) ────────────────────────────────────────
router.get('/pendientes-portal',
  verifyToken, checkPermission('asociados', 'READ'),
  ctrl.listarPendientesPortal
);
router.get('/',
  verifyToken, checkPermission('asociados', 'READ'),
  ctrl.listarAsociados
);
router.post('/importar/preview',
  verifyToken, checkPermission('asociados', 'WRITE'),
  upload.single('archivo'),
  ctrl.previewImportarCSV
);
router.post('/importar',
  verifyToken, checkPermission('asociados', 'WRITE'),
  upload.single('archivo'),
  ctrl.importarCSV
);
router.get('/sincronizaciones',
  verifyToken, checkPermission('asociados', 'READ'),
  ctrl.historialSincronizaciones
);
router.get('/sincronizaciones/:id',
  verifyToken, checkPermission('asociados', 'READ'),
  ctrl.detalleSincronizacion
);
router.patch('/sincronizaciones/:id/subsanar/:codigo',
  verifyToken, checkPermission('asociados', 'WRITE'),
  ctrl.subsanarDiscrepancia
);
router.post('/sincronizaciones/:id/revertir',
  verifyToken, checkPermission('asociados', 'WRITE'),
  ctrl.revertirSincronizacion
);

router.get('/:codigo/perfil',
  verifyToken, checkPermission('asociados', 'READ'),
  ctrl.perfilAsociado
);
router.get('/:codigo/historial-aporte',
  verifyToken, checkPermission('asociados', 'READ'),
  ctrl.historialAporte
);

// Activación del portal (opt-in)
router.post('/:codigo/activar-portal',
  verifyToken, checkPermission('asociados', 'WRITE'),
  ctrl.activarPortal
);
router.post('/:codigo/desactivar-portal',
  verifyToken, checkPermission('asociados', 'WRITE'),
  ctrl.desactivarPortal
);
router.post('/:codigo/rechazar-solicitud',
  verifyToken, checkPermission('asociados', 'WRITE'),
  ctrl.rechazarSolicitudPortal
);

export default router;
