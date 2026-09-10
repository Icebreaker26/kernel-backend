import { Router } from 'express';
import multer from 'multer';
import { verifyToken }      from '../../../middlewares/auth.js';
import { checkPermission }  from '../../../middlewares/checkPermission.js';
import * as ctrl from '../controllers/tesoreriaController.js';

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
router.get('/proveedores',      checkPermission('tesoreria', 'READ'),   ctrl.listarProveedores);
router.post('/proveedores',     checkPermission('tesoreria', 'WRITE'),  ctrl.crearProveedor);
router.put('/proveedores/:id',  checkPermission('tesoreria', 'WRITE'),  ctrl.actualizarProveedor);

// ── Facturas ───────────────────────────────────────────────────────────────────
router.get('/facturas',                        checkPermission('tesoreria', 'READ'),   ctrl.listarFacturas);
router.get('/facturas/:id',                    checkPermission('tesoreria', 'READ'),   ctrl.getFactura);
router.post('/facturas',                       checkPermission('tesoreria', 'WRITE'),  ctrl.crearFactura);
router.put('/facturas/:id/autorizar',          checkPermission('tesoreria', 'WRITE'),  ctrl.autorizarPago);
router.put('/facturas/:id/aprobar-gerencia',   checkPermission('tesoreria', 'WRITE'),  ctrl.aprobarGerencia);

// ── Config — Umbrales ──────────────────────────────────────────────────────────
router.get('/config/umbrales',     checkPermission('tesoreria', 'READ'),   ctrl.listarUmbrales);
router.post('/config/umbrales',    checkPermission('tesoreria', 'WRITE'),  ctrl.crearUmbral);
router.put('/config/umbrales/:id', checkPermission('tesoreria', 'WRITE'),  ctrl.actualizarUmbral);

// ── Conciliación manual ────────────────────────────────────────────────────────
router.get('/coincidencias',  checkPermission('tesoreria', 'READ'),  ctrl.buscarCoincidencias);
router.post('/conciliar',     checkPermission('tesoreria', 'WRITE'), ctrl.conciliarManual);

// ── Ingesta de extracto bancario ───────────────────────────────────────────────
router.post('/extracto/preview',   checkPermission('tesoreria', 'WRITE'), upload.single('archivo'), ctrl.previewExtracto);
router.post('/extracto/confirmar', checkPermission('tesoreria', 'WRITE'), upload.single('archivo'), ctrl.confirmarExtracto);

export default router;
