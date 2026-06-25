import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { loginRateLimiter } from '../../../middlewares/rateLimiter.js';
import { login, logout, me, register } from '../controllers/authController.js';

const router = Router();

router.post('/login', loginRateLimiter, login);
router.post('/logout', logout);
router.post('/register', register);
router.get('/me', verifyToken, me);

export default router;
