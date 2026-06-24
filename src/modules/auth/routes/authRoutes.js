import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { login, logout, me } from '../controllers/authController.js';

const router = Router();

router.post('/login', login);
router.post('/logout', logout);
router.get('/me', verifyToken, me);

export default router;
