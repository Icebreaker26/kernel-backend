import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/seguridadController.js';

const router = Router();
router.use(verifyToken);

// Solo admins pueden acceder al panel de seguridad
const soloAdmin = (req, res, next) =>
  req.user.rol === 'admin' ? next() : res.status(403).json({ error: 'Acceso restringido a administradores' });

router.get('/alertas',                   soloAdmin, ctrl.listarAlertas);
router.patch('/alertas/:id',             soloAdmin, ctrl.actualizarAlerta);
router.get('/metricas',                  soloAdmin, ctrl.metricas);
router.get('/login-fallidos',            soloAdmin, ctrl.loginFallidos);
router.post('/usuarios/:id/desbloquear', soloAdmin, ctrl.desbloquear);
router.post('/usuarios/:id/forzar-logout', soloAdmin, ctrl.forzarLogout);

export default router;
