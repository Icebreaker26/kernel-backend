import { Router } from 'express';
import * as ctrl from '../controllers/publicController.js';

const router = Router();

// Sin verifyToken ni checkPermission — datos públicos
router.get('/ganadores', ctrl.ganadores);

export default router;
