import { Router } from 'express';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import { listar, perfil, actualizarContacto, crearNota, eliminarNota, historial } from '../controllers/empresasController.js';

const router = Router();
router.use(verifyToken);

router.get('/',                       checkPermission('empresas', 'READ'),   listar);
router.get('/:codigo/perfil',         checkPermission('empresas', 'READ'),   perfil);
router.get('/:codigo/historial',      checkPermission('empresas', 'READ'),   historial);
router.put('/:codigo/contacto',       checkPermission('empresas', 'WRITE'),  actualizarContacto);
router.post('/:codigo/notas',         checkPermission('empresas', 'WRITE'),  crearNota);
router.delete('/notas/:id',           checkPermission('empresas', 'DELETE'), eliminarNota);

export default router;
