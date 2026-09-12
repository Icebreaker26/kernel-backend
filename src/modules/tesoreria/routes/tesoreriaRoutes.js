import { Router } from 'express';
import multer from 'multer';
import { verifyToken }      from '../../../middlewares/auth.js';
import { checkPermission }  from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/tesoreriaController.js';
import { descargarAdjunto } from '../../contable/controllers/adjuntoController.js';
import { costlyEndpointLimiter } from '../../../middlewares/rateLimiter.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB máximo
  fileFilter: (_req, file, cb) => {
    // Acepta .xls independientemente del mimetype que manda el banco
    if (file.originalname.endsWith('.xls') || file.originalname.endsWith('.xlsx')) {
      cb(null, true);
    } else {
      cb(new Error('Solo se aceptan archivos .xls o .xlsx'));
    }
  },
});

const router = Router();
router.use(verifyToken);

// ── Dashboard ──────────────────────────────────────────────────────────────────
router.get('/dashboard', checkPermission('tesoreria', 'READ'), ctrl.dashboard);

// ── Cuentas ────────────────────────────────────────────────────────────────────
router.get('/cuentas',                checkPermission('tesoreria', 'READ'),   ctrl.listarCuentas);
router.get('/cuentas/:id',            checkPermission('tesoreria', 'READ'),   ctrl.getCuenta);
router.post('/cuentas',               checkPermission('tesoreria', 'WRITE'),  ctrl.crearCuenta);
router.put('/cuentas/:id',            checkPermission('tesoreria', 'WRITE'),  ctrl.actualizarCuenta);
// Desactivación protegida: requiere DELETE + body explícito { confirmar: true, motivo }
// y la cuenta debe tener 0 movimientos
router.delete('/cuentas/:id',         checkPermission('tesoreria', 'DELETE'), ctrl.desactivarCuenta);

// ── Categorías ─────────────────────────────────────────────────────────────────
router.get('/categorias',      checkPermission('tesoreria', 'READ'),  ctrl.listarCategorias);
router.post('/categorias',     checkPermission('tesoreria', 'WRITE'), ctrl.crearCategoria);
router.put('/categorias/:id',  checkPermission('tesoreria', 'WRITE'), ctrl.actualizarCategoria);

// ── Períodos ───────────────────────────────────────────────────────────────────
router.get('/periodos',           checkPermission('tesoreria', 'READ'),   ctrl.listarPeriodos);
router.post('/periodos',          checkPermission('tesoreria', 'WRITE'),  ctrl.crearPeriodo);
router.put('/periodos/:id/cerrar', checkPermission('tesoreria', 'WRITE'), ctrl.cerrarPeriodo);

// ── Movimientos ────────────────────────────────────────────────────────────────
router.get('/movimientos/export', checkPermission('tesoreria', 'READ'),  ctrl.exportarMovimientos);
router.get('/movimientos',        checkPermission('tesoreria', 'READ'),  ctrl.listarMovimientos);
router.post('/movimientos',       checkPermission('tesoreria', 'WRITE'), ctrl.crearMovimiento);

// ── Proveedores ────────────────────────────────────────────────────────────────
router.get('/proveedores',                checkPermission('tesoreria', 'READ'),   ctrl.listarProveedores);
router.get('/proveedores/:id/perfil',     checkPermission('tesoreria', 'READ'),   ctrl.perfilProveedor);
router.get('/proveedores/:id/historial',  checkPermission('tesoreria', 'READ'),   ctrl.historialProveedor);
router.post('/proveedores',               checkPermission('tesoreria', 'WRITE'),  ctrl.crearProveedor);
router.put('/proveedores/:id',            checkPermission('tesoreria', 'WRITE'),  ctrl.actualizarProveedor);

// ── Facturas ───────────────────────────────────────────────────────────────────
router.get('/facturas/mis-pendientes',         checkPermission('tesoreria', 'READ'),   ctrl.misFacturasPendientes);
router.get('/facturas',                        checkPermission('tesoreria', 'READ'),   ctrl.listarFacturas);
router.get('/facturas/:id/adjunto',            checkPermission('tesoreria', 'READ'),   descargarAdjunto);
router.get('/facturas/:id',                    checkPermission('tesoreria', 'READ'),   ctrl.getFactura);
router.post('/facturas',                       checkPermission('tesoreria', 'WRITE'),  ctrl.crearFactura);
// C-1: acción específica por etapa — impide que el mismo usuario acumule roles
router.put('/facturas/:id/aprobar-area',       checkPermission('tesoreria', 'APROBAR_AREA'),    ctrl.aprobarArea);
router.put('/facturas/:id/autorizar',          checkPermission('tesoreria', 'AUTORIZAR'),       ctrl.autorizarPago);
router.put('/facturas/:id/aprobar-gerencia',   checkPermission('tesoreria', 'APROBAR_GERENCIA'),ctrl.aprobarGerencia);
router.put('/facturas/:id/rechazar-gerencia',  checkPermission('tesoreria', 'APROBAR_GERENCIA'),ctrl.rechazarGerencia);

// ── Usuarios disponibles (selector de responsable) ─────────────────────────────
router.get('/usuarios-disponibles', checkPermission('tesoreria', 'READ'), ctrl.listarUsuariosDisponibles);

// ── Config — Umbrales ──────────────────────────────────────────────────────────
router.get('/config/umbrales',     checkPermission('tesoreria', 'READ'),         ctrl.listarUmbrales);
// A-2: modificar umbrales requiere acción específica CONFIG_UMBRAL
router.post('/config/umbrales',    checkPermission('tesoreria', 'CONFIG_UMBRAL'),ctrl.crearUmbral);
router.put('/config/umbrales/:id', checkPermission('tesoreria', 'CONFIG_UMBRAL'),ctrl.actualizarUmbral);

// ── Conciliación manual ────────────────────────────────────────────────────────
router.get('/coincidencias',  costlyEndpointLimiter, checkPermission('tesoreria', 'READ'),    ctrl.buscarCoincidencias);
// C-1: CONCILIAR es acción separada — no cualquier usuario con WRITE puede conciliar
router.post('/conciliar',     checkPermission('tesoreria', 'CONCILIAR'), ctrl.conciliarManual);

// ── Ingesta de extracto bancario ───────────────────────────────────────────────
router.post('/extracto/preview',   checkPermission('tesoreria', 'WRITE'),   upload.single('archivo'), ctrl.previewExtracto);
router.post('/extracto/confirmar', checkPermission('tesoreria', 'CONCILIAR'),upload.single('archivo'), ctrl.confirmarExtracto);

export default router;
