import { Router } from 'express';
import multer from 'multer';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/firmaController.js';

const router = Router();
// El PDF a verificar se lee en memoria y se descarta: no se persiste nada
const subir = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

router.use(verifyToken);

router.post('/sello',           checkPermission('firma', 'WRITE'), ctrl.sellar);
router.post('/registro',        checkPermission('firma', 'WRITE'), ctrl.registrarFinal);
router.post('/verificar',       checkPermission('firma', 'READ'),  subir.single('archivo'), ctrl.verificar);
router.post('/verificar-token', checkPermission('firma', 'READ'),  ctrl.verificarToken);
router.get ('/clave-publica',   checkPermission('firma', 'READ'),  ctrl.clavePublica);

export default router;
