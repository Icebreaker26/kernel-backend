import { Router } from 'express';
import multer from 'multer';
import { verifyToken } from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/carteraController.js';

const router = Router();

// Un identificador mal formado no debe llegar a la base de datos (daría un 500): se responde 404 como cualquier recurso inexistente
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validarUuid = (req, res, next, valor) => (UUID.test(valor) ? next() : res.status(404).json({ error: 'No encontrado' }));
for (const p of ['id', 'docId', 'archivoId']) router.param(p, validarUuid);

// Los archivos se leen en memoria para comprobar su contenido antes de guardarlos (el firmado del motor puede pesar hasta 25 MB)
const subir = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });
const subirFirmado = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

router.use(verifyToken);

// Reportes mensuales y parámetros (antes de /:id)
router.get('/reportes/avales',               checkPermission('cartera', 'READ'),       ctrl.avalesDelMes);
router.get('/reportes/firmas-electronicas',  checkPermission('cartera', 'READ'),       ctrl.firmasElectronicasDelMes);
router.get('/parametros',                    checkPermission('cartera', 'READ'),       ctrl.obtenerParametros);
router.put('/parametros/tarifa-firma',       checkPermission('cartera', 'CONFIGURAR'), ctrl.guardarTarifa);

router.get ('/resumen',                 checkPermission('cartera', 'READ'),  ctrl.resumen);
router.get ('/filtros',                 checkPermission('cartera', 'READ'),  ctrl.filtros);
router.get ('/',                        checkPermission('cartera', 'READ'),  ctrl.listar);
router.get ('/:id',                     checkPermission('cartera', 'READ'),  ctrl.obtener);
router.get ('/:id/archivos/:archivoId/url', checkPermission('cartera', 'READ'), ctrl.urlArchivo);
router.get ('/:id/expediente',          checkPermission('cartera', 'READ'),  ctrl.expediente);
router.get ('/:id/integridad',          checkPermission('cartera', 'READ'),  ctrl.integridad);
router.post('/:id/recibir',             checkPermission('cartera', 'WRITE'), ctrl.recibir);
router.post('/:id/devolver',            checkPermission('cartera', 'WRITE'), ctrl.devolver);

// Cierre: comprobante y estudio firmados, aval, desembolso neto, sellos, PDF final y paso a Control Interno
router.get ('/:id/cierre',                         checkPermission('cartera', 'READ'),  ctrl.obtenerCierre);
router.put ('/:id/cierre',                         checkPermission('cartera', 'WRITE'), ctrl.guardarCierre);
router.post('/:id/cierre/documentos',              checkPermission('cartera', 'WRITE'), subir.single('archivo'), ctrl.subirDocumento);
router.get ('/:id/cierre/documentos/:docId/contenido', checkPermission('cartera', 'WRITE'), ctrl.contenidoDocumento);
router.post('/:id/cierre/firmado',                 checkPermission('cartera', 'WRITE'), subirFirmado.single('archivo'), ctrl.registrarFirmado);
router.get ('/:id/cierre/comprobante',                checkPermission('cartera', 'READ'),  ctrl.comprobante);
router.get ('/:id/pdf-final',                      checkPermission('cartera', 'READ'),  ctrl.pdfFinal);
router.post('/:id/completar',                      checkPermission('cartera', 'WRITE'), ctrl.completar);

export default router;
