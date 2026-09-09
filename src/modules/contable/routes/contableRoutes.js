import { Router } from 'express';
import { verifyToken }     from '../../../middlewares/auth.js';
import { checkPermission } from '../../../middlewares/checkPermission.js';
import {
  listarFacturas, getFactura, crearFactura, reenviarFactura,
  listarProveedores, crearProveedor, actualizarProveedor,
} from '../../tesoreria/controllers/tesoreriaController.js';

const router = Router();
router.use(verifyToken);

// ── Facturas ───────────────────────────────────────────────────────────────────
router.get('/facturas',                checkPermission('contable', 'READ'),  listarFacturas);
router.get('/facturas/:id',            checkPermission('contable', 'READ'),  getFactura);
router.post('/facturas',               checkPermission('contable', 'WRITE'), crearFactura);
router.put('/facturas/:id/reenviar',   checkPermission('contable', 'WRITE'), reenviarFactura);

// ── Proveedores (lectura + gestión desde Contable) ─────────────────────────────
router.get('/proveedores',     checkPermission('contable', 'READ'),  listarProveedores);
router.post('/proveedores',    checkPermission('contable', 'WRITE'), crearProveedor);
router.put('/proveedores/:id', checkPermission('contable', 'WRITE'), actualizarProveedor);

export default router;
