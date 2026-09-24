import { Router } from 'express';
import multer from 'multer';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/creditosController.js';
import { tieneAccion } from '../services/creditoService.js';

const router = Router();

// Un identificador mal formado no debe llegar a la base de datos (daría un 500): se responde 404 como cualquier recurso inexistente
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validarUuid = (req, res, next, valor) => (UUID.test(valor) ? next() : res.status(404).json({ error: 'No encontrado' }));
for (const p of ['id', 'docId', 'archivoId']) router.param(p, validarUuid);
// Los archivos se leen en memoria para comprobar su contenido antes de guardarlos
const subir = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 2 } });

// El PDF firmado por el motor puede pesar hasta 25 MB (el motor admite 20 MB por documento más la constancia)
const subirFirmado = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

router.use(verifyToken);

// Los documentos de un asociado los consulta quien trabaja Créditos o Cartera (el servicio limita al asesor a lo suyo)
const lecturaCreditosOCartera = async (req, res, next) => {
  try {
    if ((await tieneAccion(req.user, 'creditos', 'READ')) || (await tieneAccion(req.user, 'cartera', 'READ'))) return next();
    return res.status(403).json({ error: 'Sin permiso' });
  } catch (err) { return next(err); }
};

// Catálogos, búsqueda y configuración (van antes de /:id)
router.get ('/categorias',              checkPermission('creditos', 'READ'),       ctrl.categorias);
router.get ('/asociados/buscar',        checkPermission('creditos', 'READ'),       ctrl.buscarAsociados);
router.get ('/asociados/:codigo/documentos', lecturaCreditosOCartera, ctrl.documentosDeAsociado);
router.get ('/asociados/:codigo/documentos/:archivoId/url', lecturaCreditosOCartera, ctrl.urlArchivoDeAsociado);
router.get ('/asociados/:codigo',       checkPermission('creditos', 'READ'),       ctrl.infoAsociado);
router.get ('/asesores',               checkPermission('creditos', 'CONFIGURAR'), ctrl.listarAsesores);
router.get ('/config/empresas',         checkPermission('creditos', 'CONFIGURAR'), ctrl.listarConfigEmpresas);
router.put ('/config/empresas/:codigo', checkPermission('creditos', 'CONFIGURAR'), ctrl.guardarConfigEmpresa);

// Solicitudes
router.get ('/resumen', checkPermission('creditos', 'READ'), ctrl.resumen);
router.get ('/filtros', checkPermission('creditos', 'READ'), ctrl.filtros);
router.get ('/',    checkPermission('creditos', 'READ'),  ctrl.listar);
router.post('/',    checkPermission('creditos', 'WRITE'), ctrl.radicar);
router.get ('/:id', checkPermission('creditos', 'READ'),  ctrl.obtener);
router.put ('/:id', checkPermission('creditos', 'WRITE'), ctrl.actualizar);

// Documentos y firma
router.post  ('/:id/documentos/borrador', checkPermission('creditos', 'WRITE'), subir.single('archivo'), ctrl.subirBorrador);
router.post  ('/:id/documentos/adjunto',  checkPermission('creditos', 'WRITE'), subir.single('archivo'), ctrl.subirAdjunto);
router.delete('/:id/documentos/:docId',   checkPermission('creditos', 'WRITE'), ctrl.quitarDocumento);
router.post  ('/:id/firma-externa',       checkPermission('creditos', 'WRITE'), subir.fields([{ name: 'archivo', maxCount: 1 }, { name: 'evidencia', maxCount: 1 }]), ctrl.firmaExterna);
router.get   ('/:id/documentos/:docId/contenido', checkPermission('creditos', 'WRITE'), ctrl.contenidoParaFirma);   // bytes del documento a firmar, para el motor de firma
router.post  ('/:id/firmado',             checkPermission('creditos', 'WRITE'), subirFirmado.single('archivo'), ctrl.registrarFirmado);
router.get   ('/:id/archivos/:archivoId/url', checkPermission('creditos', 'READ'), ctrl.urlArchivo);
router.get   ('/:id/integridad',          checkPermission('creditos', 'READ'),  ctrl.integridad);

// Autorización de la empresa
router.post('/:id/autorizacion/enviar',    checkPermission('creditos', 'WRITE'), ctrl.enviarAutorizacion);
router.post('/:id/autorizacion/registrar', checkPermission('creditos', 'WRITE'), subir.single('archivo'), ctrl.registrarAutorizacion);

// Transiciones
router.post('/:id/entregar', checkPermission('creditos', 'ENTREGAR'), ctrl.entregar);
router.post('/:id/cerrar',   checkPermission('creditos', 'WRITE'),    ctrl.cerrar);
router.post('/:id/reasignar', checkPermission('creditos', 'CONFIGURAR'), ctrl.reasignar);   // además exige rol admin (en el servicio)

export default router;
