import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { eventoAnaliticaLimiter } from '../../../middlewares/rateLimiter.js';
import * as ctrl from '../controllers/analiticaController.js';

const router = Router();

// Público: lo llama el sitio (una vista por página y unos pocos clics). Sin cookies ni datos personales.
router.post('/pub/evento', eventoAnaliticaLimiter, ctrl.pubEvento);

router.use(verifyToken);

router.get('/resumen', checkPermission('analitica', 'READ'), ctrl.resumen);

export default router;
