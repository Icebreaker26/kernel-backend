import { Router } from 'express';
import { verifyToken }     from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import {
  listarFacturas, getFactura, crearFactura, reenviarFactura,
  listarProveedores, crearProveedor, actualizarProveedor, perfilProveedor,
  listarCategorias, crearCategoria, actualizarCategoria,
  listarPeriodos, crearPeriodo, cerrarPeriodo,
} from '../../tesoreria/controllers/tesoreriaController.js';
import {
  getEstado, solicitarCambio,
  solicitarCertificadoUpload, confirmarCertificadoUpload,
  verCertificadoDeProveedor,
} from '../../control_interno/controllers/datosBancariosController.js';
import {
  solicitarUpload, confirmarUpload, descargarAdjunto, listarAdjuntos,
  descargarArchivo, eliminarAdjunto, eliminarArchivoEspecifico,
} from '../controllers/adjuntoController.js';

const router = Router();
router.use(verifyToken);

// ── Facturas ───────────────────────────────────────────────────────────────────
router.get('/facturas',                checkPermission('contable', 'READ'),  listarFacturas);
router.get('/facturas/:id',            checkPermission('contable', 'READ'),  getFactura);
router.post('/facturas',               checkPermission('contable', 'WRITE'), crearFactura);
router.put('/facturas/:id/reenviar',   checkPermission('contable', 'WRITE'), reenviarFactura);

// ── Proveedores (lectura + gestión desde Contable) ─────────────────────────────
router.get('/proveedores',                        checkPermission('contable', 'READ'),  listarProveedores);
router.get('/proveedores/:id/perfil',             checkPermission('contable', 'READ'),  perfilProveedor);
router.get('/proveedores/:id/datos-bancarios',                          checkPermission('contable', 'READ'),  getEstado);
router.get('/proveedores/:id/certificado',                              checkPermission('contable', 'READ'),  verCertificadoDeProveedor);
router.post('/proveedores/:id/datos-bancarios',                         checkPermission('contable', 'WRITE'), solicitarCambio);
router.post('/proveedores/:id/datos-bancarios/:solicitudId/certificado', checkPermission('contable', 'WRITE'), solicitarCertificadoUpload);
router.patch('/proveedores/:id/datos-bancarios/:solicitudId/certificado', checkPermission('contable', 'WRITE'), confirmarCertificadoUpload);
router.post('/proveedores',                       checkPermission('contable', 'WRITE'), crearProveedor);
router.put('/proveedores/:id',                    checkPermission('contable', 'WRITE'), actualizarProveedor);

// ── Archivos de facturas ───────────────────────────────────────────────────────
router.post('/facturas/:id/adjunto',                       checkPermission('contable', 'WRITE'), solicitarUpload);
router.patch('/facturas/:id/adjunto',                      checkPermission('contable', 'WRITE'), confirmarUpload);
router.get('/facturas/:id/adjunto',                        checkPermission('contable', 'READ'),  descargarAdjunto);
router.delete('/facturas/:id/adjunto',                     checkPermission('contable', 'WRITE'), eliminarAdjunto);
router.get('/facturas/:id/archivos',                       checkPermission('contable', 'READ'),  listarAdjuntos);
router.get('/facturas/:id/archivos/:archivoId',            checkPermission('contable', 'READ'),  descargarArchivo);
router.delete('/facturas/:id/archivos/:archivoId',         checkPermission('contable', 'WRITE'), eliminarArchivoEspecifico);

// ── Categorías ─────────────────────────────────────────────────────────────────
router.get('/categorias',     checkPermission('contable', 'READ'),  listarCategorias);
router.post('/categorias',    checkPermission('contable', 'WRITE'), crearCategoria);
router.put('/categorias/:id', checkPermission('contable', 'WRITE'), actualizarCategoria);

// ── Períodos ───────────────────────────────────────────────────────────────────
router.get('/periodos',              checkPermission('contable', 'READ'),  listarPeriodos);
router.post('/periodos',             checkPermission('contable', 'WRITE'), crearPeriodo);
router.put('/periodos/:id/cerrar',   checkPermission('contable', 'WRITE'), cerrarPeriodo);

export default router;
