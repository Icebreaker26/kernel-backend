import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/mailingController.js';

const router = Router();
router.use(verifyToken);

router.get('/',              checkPermission('mailing', 'READ'),   ctrl.listar);
router.get('/candidatos',   checkPermission('mailing', 'READ'),   ctrl.candidatos);
router.get('/jornadas',     checkPermission('mailing', 'READ'),   ctrl.listarJornadas);
router.get('/contactos',    checkPermission('mailing', 'READ'),   ctrl.listarContactos);
router.post('/contactos',   checkPermission('mailing', 'WRITE'),  ctrl.crearContacto);
router.delete('/contactos/:id', checkPermission('mailing', 'DELETE'), ctrl.eliminarContacto);
router.post('/',             checkPermission('mailing', 'WRITE'),  ctrl.crear);
router.get('/:id/preview',  checkPermission('mailing', 'READ'),   ctrl.preview);
router.post('/:id/enviar',  checkPermission('mailing', 'WRITE'),  ctrl.enviar);
router.put('/:id',           checkPermission('mailing', 'WRITE'),  ctrl.actualizar);
router.delete('/:id',        checkPermission('mailing', 'DELETE'), ctrl.eliminar);

export default router;
