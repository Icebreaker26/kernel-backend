import { Router } from 'express';
import { paginaPublicaLimiter } from '../../../middlewares/rateLimiter.js';
import * as ctrl from '../controllers/sitioController.js';

// Todo lo de este módulo es público (contenido del sitio web); no hay endpoints con sesión.
const router = Router();

router.get('/pub/tutoriales/:clave', paginaPublicaLimiter, ctrl.pubTutorial);

export default router;
