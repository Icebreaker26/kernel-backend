import { Router } from 'express';
import multer from 'multer';
import { verifyToken } from '../../../middlewares/auth.js';
import { verifyAsociado } from '../../../middlewares/authAsociado.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/asociadosController.js';

const router  = Router();
const upload  = multer({ storage: multer.memoryStorage() });

// Rutas públicas del portal asociado
router.post('/login',  ctrl.loginAsociado);
router.post('/logout', ctrl.logoutAsociado);
router.get('/me',      verifyAsociado, ctrl.meAsociado);

// Rutas de administración (solo usuarios del sistema con permiso)
router.get('/',
  verifyToken, checkPermission('asociados', 'READ'),
  ctrl.listarAsociados
);
router.post('/importar',
  verifyToken, checkPermission('asociados', 'WRITE'),
  upload.single('archivo'),
  ctrl.importarCSV
);

export default router;
