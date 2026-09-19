import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { pqrsCrearLimiter, pqrsConsultaLimiter, paginaPublicaLimiter } from '../../../middlewares/rateLimiter.js';
import * as ctrl from '../controllers/pqrsController.js';

const router = Router();

// Público: el formulario y la consulta de estado del sitio
router.get ('/pub/config',   paginaPublicaLimiter, ctrl.pubConfig);
router.post('/pub',          pqrsCrearLimiter,     ctrl.pubCrear);
router.post('/pub/consulta', pqrsConsultaLimiter,  ctrl.pubConsultar);

router.use(verifyToken);

router.get ('/',                checkPermission('pqrs', 'READ'),  ctrl.listar);
router.get ('/asignables',      checkPermission('pqrs', 'READ'),  ctrl.asignables);
router.get ('/:id',             checkPermission('pqrs', 'READ'),  ctrl.obtener);
router.put ('/:id/estado',      checkPermission('pqrs', 'WRITE'), ctrl.cambiarEstado);
router.put ('/:id/asignar',     checkPermission('pqrs', 'WRITE'), ctrl.asignar);
router.post('/:id/notas',       checkPermission('pqrs', 'WRITE'), ctrl.agregarNota);
router.post('/:id/responder',   checkPermission('pqrs', 'WRITE'), ctrl.responder);

export default router;
