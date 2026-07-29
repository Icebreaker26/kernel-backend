import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { buscar } from '../controllers/busquedaController.js';

const router = Router();
router.use(verifyToken);

router.get('/', buscar);

export default router;
