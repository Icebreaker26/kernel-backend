import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/perfilController.js';
import { actualizarPerfilSchema, cambiarPasswordSchema } from '../schemas/perfilSchema.js';

const router = Router();
router.use(verifyToken);

router.get('/', checkPermission('perfil', 'READ'), ctrl.obtenerPerfil);

router.put('/',
  checkPermission('perfil', 'WRITE'),
  (req, res, next) => {
    if (req.user.rol !== 'admin') return res.status(403).json({ error: 'Solo el administrador puede modificar datos personales' });
    actualizarPerfilSchema.parse(req.body);
    next();
  },
  ctrl.actualizarPerfil
);

router.put('/password',
  checkPermission('perfil', 'WRITE'),
  (req, res, next) => { cambiarPasswordSchema.parse(req.body); next(); },
  ctrl.cambiarPassword
);

export default router;
