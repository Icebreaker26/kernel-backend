import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { env } from '../../../config/env.js';
import * as ctrl from '../controllers/monitorController.js';

const router = Router();

// Permite que el relay llame a este endpoint al arrancar (sin JWT, con header secreto)
// También acepta staff autenticado con permiso WRITE
const relayOrAdmin = (req, res, next) => {
  const secret = req.headers['x-relay-secret'];
  if (env.RELAY_SECRET && secret === env.RELAY_SECRET) return next();
  verifyToken(req, res, (err) => {
    if (err) return next(err);
    checkPermission('monitor', 'WRITE')(req, res, next);
  });
};

// Va antes del verifyToken global — tiene su propia autenticación dual
router.post('/reintentar-pendientes', relayOrAdmin, ctrl.reintentarPendientes);

router.use(verifyToken);

router.get('/metricas',     checkPermission('monitor', 'READ'), ctrl.metricas);
router.get('/ingresos',     checkPermission('monitor', 'READ'), ctrl.ingresos);
router.get('/emails',       checkPermission('monitor', 'READ'), ctrl.emails);
router.get('/relay-status', checkPermission('monitor', 'READ'), ctrl.relayStatus);

export default router;
