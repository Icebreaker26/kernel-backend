import { Router, text } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/emailController.js';

const router = Router();

// Público: lo llama Amazon SNS (Content-Type text/plain, sin cookie ni X-Requested-With).
// Se autentica con la firma de SNS y el ARN del tema, no con JWT.
router.post('/ses-eventos', text({ type: '*/*', limit: '256kb' }), ctrl.recibirEventosSes);

router.use(verifyToken);

router.get   ('/supresiones',     checkPermission('mailing', 'READ'),   ctrl.listarSupresiones);
router.delete('/supresiones/:id', checkPermission('mailing', 'DELETE'), ctrl.reactivarDireccion);

export default router;
