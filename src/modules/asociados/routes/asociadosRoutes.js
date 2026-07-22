import { Router } from 'express';
import multer from 'multer';
import { verifyToken } from '../../../middlewares/auth.js';
import { verifyAsociado } from '../../../middlewares/authAsociado.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { loginRateLimiter } from '../../../middlewares/rateLimiter.js';
import * as ctrl from '../controllers/asociadosController.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage() });

// ── Portal del asociado ───────────────────────────────────────────────────────
router.post('/login',  loginRateLimiter, ctrl.loginAsociado);
router.post('/logout', ctrl.logoutAsociado);
router.get ('/me',                         verifyAsociado, ctrl.meAsociado);
router.put ('/password',                   verifyAsociado, ctrl.cambiarPasswordAsociado);
router.get ('/notificaciones',             verifyAsociado, ctrl.listarNotificaciones);
router.patch('/notificaciones/leer-todas', verifyAsociado, ctrl.marcarTodasNotifsLeidas);
router.patch('/notificaciones/:id/leer',   verifyAsociado, ctrl.marcarNotifLeida);

// ── Administración (staff con permiso) ────────────────────────────────────────
router.get('/',
  verifyToken, checkPermission('asociados', 'READ'),
  ctrl.listarAsociados
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

// Activación del portal (opt-in)
router.post('/:codigo/activar-portal',
  verifyToken, checkPermission('asociados', 'WRITE'),
  ctrl.activarPortal
);
router.post('/:codigo/desactivar-portal',
  verifyToken, checkPermission('asociados', 'WRITE'),
  ctrl.desactivarPortal
);

export default router;
