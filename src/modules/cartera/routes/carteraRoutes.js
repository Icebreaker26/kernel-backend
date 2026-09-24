import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/carteraController.js';

const router = Router();

// Un identificador mal formado no debe llegar a la base de datos (daría un 500): se responde 404 como cualquier recurso inexistente
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validarUuid = (req, res, next, valor) => (UUID.test(valor) ? next() : res.status(404).json({ error: 'No encontrado' }));
for (const p of ['id', 'docId', 'archivoId']) router.param(p, validarUuid);
router.use(verifyToken);

router.get ('/',                        checkPermission('cartera', 'READ'),  ctrl.listar);
router.get ('/:id',                     checkPermission('cartera', 'READ'),  ctrl.obtener);
router.get ('/:id/archivos/:archivoId/url', checkPermission('cartera', 'READ'), ctrl.urlArchivo);
router.get ('/:id/expediente',          checkPermission('cartera', 'READ'),  ctrl.expediente);
router.get ('/:id/integridad',          checkPermission('cartera', 'READ'),  ctrl.integridad);
router.post('/:id/recibir',             checkPermission('cartera', 'WRITE'), ctrl.recibir);
router.post('/:id/devolver',            checkPermission('cartera', 'WRITE'), ctrl.devolver);

export default router;
