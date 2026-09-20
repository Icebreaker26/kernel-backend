import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { paginaPublicaLimiter } from '../../../middlewares/rateLimiter.js';
import * as ctrl from '../controllers/blogController.js';

const router = Router();

// Público: el blog del sitio (/blog y /blog/:slug)
router.get('/pub',               paginaPublicaLimiter, ctrl.pubListar);
router.get('/pub/:slug',         paginaPublicaLimiter, ctrl.pubDetalle);
router.get('/pub/:slug/portada', paginaPublicaLimiter, ctrl.pubPortada);

router.use(verifyToken);

router.get   ('/',                       checkPermission('blog', 'READ'),   ctrl.listar);
router.post  ('/',                       checkPermission('blog', 'WRITE'),  ctrl.crear);
router.get   ('/categorias',             checkPermission('blog', 'READ'),   ctrl.listarCategorias);
router.post  ('/categorias',             checkPermission('blog', 'WRITE'),  ctrl.crearCategoria);
router.get   ('/:id',                    checkPermission('blog', 'READ'),   ctrl.obtener);
router.put   ('/:id',                    checkPermission('blog', 'WRITE'),  ctrl.actualizar);
router.delete('/:id',                    checkPermission('blog', 'DELETE'), ctrl.eliminar);
router.get   ('/:id/portada',            checkPermission('blog', 'READ'),   ctrl.verPortada);
router.post  ('/:id/portada/solicitar',  checkPermission('blog', 'WRITE'),  ctrl.solicitarPortada);
router.patch ('/:id/portada/confirmar',  checkPermission('blog', 'WRITE'),  ctrl.confirmarPortada);
router.delete('/:id/portada',            checkPermission('blog', 'WRITE'),  ctrl.quitarPortada);

export default router;
