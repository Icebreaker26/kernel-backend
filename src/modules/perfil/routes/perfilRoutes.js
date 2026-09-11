import { Router } from 'express';
import multer from 'multer';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/perfilController.js';
import { actualizarPerfilSchema, cambiarPasswordSchema } from '../schemas/perfilSchema.js';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 3 * 1024 * 1024 } });

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

router.post('/avatar',
  checkPermission('perfil', 'WRITE'),
  upload.single('avatar'),
  ctrl.subirAvatar
);

export default router;
