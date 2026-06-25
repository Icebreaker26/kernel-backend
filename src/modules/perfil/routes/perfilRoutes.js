import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import * as ctrl from '../controllers/perfilController.js';

const router = Router();
router.use(verifyToken);

router.get('/',          ctrl.obtenerPerfil);
router.put('/',          ctrl.actualizarPerfil);
router.put('/password',  ctrl.cambiarPassword);

export default router;
