import {
  Document, Packer, Paragraph, Table, TableRow, TableCell,
  TextRun, HeadingLevel, AlignmentType, WidthType, BorderStyle,
  ShadingType, TableLayoutType,
} from 'docx';
import fs from 'fs';
import path from 'path';

const ACCENT  = '1E3A5F';
const ACCENT2 = '2E6DA4';
const GREEN   = '1A5C3A';
const GRAY    = 'F2F4F7';
const WHITE   = 'FFFFFF';
const BLACK   = '1A1A1A';

const noBorder = {
  top:    { style: BorderStyle.NONE, size: 0 },
  bottom: { style: BorderStyle.NONE, size: 0 },
  left:   { style: BorderStyle.NONE, size: 0 },
  right:  { style: BorderStyle.NONE, size: 0 },
};

const thinBorder = (color = 'CCCCCC') => ({
  top:    { style: BorderStyle.SINGLE, size: 4, color },
  bottom: { style: BorderStyle.SINGLE, size: 4, color },
  left:   { style: BorderStyle.SINGLE, size: 4, color },
  right:  { style: BorderStyle.SINGLE, size: 4, color },
});

const run = (text, opts = {}) => new TextRun({
  text, font: 'Calibri',
  size:   (opts.size ?? 11) * 2,
  bold:   opts.bold   ?? false,
  italic: opts.italic ?? false,
  color:  opts.color  ?? BLACK,
  ...opts,
});

const para = (children, opts = {}) => new Paragraph({
  children: Array.isArray(children) ? children : [children],
  alignment: opts.align ?? AlignmentType.LEFT,
  spacing:   { before: opts.before ?? 0, after: opts.after ?? 120 },
  ...opts,
});

const heading1 = (text) => new Paragraph({
  children: [new TextRun({ text, font: 'Calibri', size: 28, bold: true, color: WHITE })],
  shading: { type: ShadingType.SOLID, color: ACCENT, fill: ACCENT },
  spacing: { before: 240, after: 240 },
  indent:  { left: 200, right: 200 },
});

const heading2 = (text, color = ACCENT2) => new Paragraph({
  children: [new TextRun({ text, font: 'Calibri', size: 24, bold: true, color: WHITE })],
  shading: { type: ShadingType.SOLID, color, fill: color },
  spacing: { before: 320, after: 160 },
  indent:  { left: 100, right: 100 },
});

const heading3 = (text) => new Paragraph({
  children: [new TextRun({ text, font: 'Calibri', size: 22, bold: true, color: ACCENT })],
  spacing: { before: 280, after: 100 },
  border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: ACCENT2 } },
});

const bullet = (text) => new Paragraph({
  children: [run(text, { size: 10 })],
  bullet: { level: 0 },
  spacing: { before: 40, after: 40 },
});

const space = (n = 1) => new Paragraph({
  children: [run('')],
  spacing: { before: 0, after: n * 80 },
});

const cell = (text, opts = {}) => new TableCell({
  children: [new Paragraph({
    children: [new TextRun({
      text, font: 'Calibri',
      size:  (opts.size ?? 10) * 2,
      bold:  opts.bold  ?? false,
      color: opts.color ?? BLACK,
    })],
    alignment: opts.align ?? AlignmentType.LEFT,
    spacing: { before: 60, after: 60 },
  })],
  width:   opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
  shading: opts.shade ? { type: ShadingType.SOLID, color: opts.shade, fill: opts.shade } : undefined,
  borders: opts.borders ?? thinBorder(),
  margins: { top: 80, bottom: 80, left: 120, right: 120 },
  verticalAlign: 'center',
});

const headerRow = (cols, color = ACCENT) => new TableRow({
  children: cols.map(([text, width]) => cell(text, { bold: true, color: WHITE, shade: color, width, size: 10 })),
  tableHeader: true,
});

const dataRow = (cols, shade) => new TableRow({
  children: cols.map(([text, width, align]) => cell(text, {
    width, shade, align: align ?? AlignmentType.LEFT, size: 10,
  })),
});

const mkTable = (header, rows, color = ACCENT) => new Table({
  layout: TableLayoutType.FIXED,
  width:  { size: 100, type: WidthType.PERCENTAGE },
  rows: [
    headerRow(header, color),
    ...rows.map((r, i) => dataRow(r, i % 2 === 0 ? WHITE : GRAY)),
  ],
});

// ── Documento ──────────────────────────────────────────────────────────────

const doc = new Document({
  styles: {
    default: {
      document: { run: { font: 'Calibri', size: 22, color: BLACK } },
    },
  },
  sections: [{
    properties: { page: { margin: { top: 720, bottom: 720, left: 900, right: 900 } } },
    children: [

      // ── PORTADA ──────────────────────────────────────────────────────────

      heading1('PROPUESTA DE DESARROLLO DE SOFTWARE'),
      heading1('Sistema de Gestión Operativa — KERNEL'),

      space(2),

      para([run('Cliente:', { bold: true }),      run('  Cooperativa Progresemos')], { before: 80 }),
      para([run('Desarrollador:', { bold: true }), run('  Alejandro M. Torres')]),
      para([run('Contacto:', { bold: true }),      run('  alejandro.torres0826@gmail.com')]),
      para([run('Fecha:', { bold: true }),         run('  Junio 2026')]),
      para([run('Duración estimada:', { bold: true }), run('  6 – 7 meses')]),

      space(3),

      // ── DESCRIPCIÓN GENERAL ───────────────────────────────────────────────

      heading2('DESCRIPCIÓN GENERAL'),
      space(),

      para(run(
        'Se desarrolla la plataforma operativa digital integral de la Cooperativa Progresemos — ' +
        'un sistema web moderno, seguro y escalable que centraliza las operaciones de las áreas ' +
        'comercial, financiera, de seguros y de crédito, con acceso tanto para empleados como para asociados.',
        { size: 11 }
      ), { after: 120 }),

      para(run(
        'El proyecto reemplaza el sistema anterior (Platinum/Railway) y los procesos manuales existentes, ' +
        'construyendo una plataforma unificada que crece módulo a módulo sobre una infraestructura compartida. ' +
        'El plazo estimado de entrega completa es de 6 a 7 meses.',
        { size: 11 }
      ), { after: 200 }),

      space(2),

      // ── FASE 1 — YA ENTREGADO ─────────────────────────────────────────────

      heading2('FASE 1 — ENTREGADO', GREEN),
      space(),

      para(run(
        'Los siguientes módulos han sido desarrollados, probados y puestos en producción.',
        { size: 11, italic: true, color: '555555' }
      ), { after: 180 }),

      // M1 Core
      heading3('Módulo 1 — Core del sistema'),

      para(run(
        'Infraestructura base que soporta todos los módulos actuales y futuros.',
        { size: 10, italic: true, color: '666666' }
      ), { after: 100 }),

      mkTable(
        [['Entregable', 40], ['Descripción', 60]],
        [
          [['Base de datos', 40], ['14 migraciones, PKs UUID, borrado lógico, índices de performance', 60]],
          [['Autenticación empleados', 40], ['Login/logout JWT en cookie HttpOnly, rate limiting, flujo de aprobación', 60]],
          [['Portal de asociados', 40], ['Acceso independiente por cédula, mis datos, cambio de contraseña', 60]],
          [['Sistema de permisos ACL', 40], ['Permisos granulares por módulo y acción (READ/WRITE/DELETE) por usuario', 60]],
          [['Módulo Admin', 40], ['Gestión de usuarios: crear, aprobar, roles, permisos, auditoría completa', 60]],
          [['Módulo Asociados', 40], ['Padrón con búsqueda avanzada, filtros, paginación, importación CSV', 60]],
          [['Módulo Empresas', 40], ['Listado de empresas vinculadas con estado y asociados activos', 60]],
          [['Módulo Perfil', 40], ['Consulta y edición de datos propios, cambio de contraseña', 60]],
          [['Notificaciones en tiempo real', 40], ['Socket.IO, persistencia en DB, bell dropdown, filtrado por permisos', 60]],
          [['Tests de integración', 40], ['64 pruebas automáticas en 6 módulos contra base de datos real', 60]],
          [['CI/CD', 40], ['GitHub Actions: verificación automática del sistema en cada actualización', 60]],
        ],
        GREEN
      ),

      space(2),

      // M2 Migración
      heading3('Módulo 2 — Migración de datos'),

      para(run(
        'Incluido en el valor del Core. Traslado completo del historial desde el sistema anterior.',
        { size: 10, italic: true, color: '666666' }
      ), { after: 100 }),

      mkTable(
        [['Entregable', 40], ['Descripción', 60]],
        [
          [['Script de sincronización', 40], ['Lectura de solo lectura desde Railway, upsert idempotente de empresas, asociados, boletos y logs', 60]],
          [['Casos especiales', 40], ['Normalización de nombres, encoding corrupto, mapeo de acciones, contraseñas por defecto', 60]],
          [['Re-sync incremental', 40], ['Modo dry-run y ejecución real; seguro de correr múltiples veces sin duplicar datos', 60]],
        ],
        GREEN
      ),

      space(2),

      // M3 Sorteos
      heading3('Módulo 3 — Sorteos'),

      para(run(
        'Adaptación y rediseño del módulo existente en el sistema anterior, integrado al nuevo Core.',
        { size: 10, italic: true, color: '666666' }
      ), { after: 100 }),

      mkTable(
        [['Entregable', 40], ['Descripción', 60]],
        [
          [['Gestión de boletos', 40], ['Grid 1.000 celdas, máquina de estados, transacciones con control de concurrencia', 60]],
          [['Asignación directa', 40], ['Buscador de asociado, selección de boleto, confirmación y registro de auditoría', 60]],
          [['Solicitudes de asociados', 40], ['Portal para solicitar/retirar bonos; empleado aprueba o rechaza con notificación', 60]],
          [['Empresas por sorteo', 40], ['Toggle de habilitación por empresa, solo asociados de empresas activas participan', 60]],
          [['Panel de participantes', 40], ['Tabla paginada con búsqueda, historial por asociado, exportación Excel', 60]],
          [['Estadísticas', 40], ['Métricas, gráficas, mapa SVG de Colombia interactivo, exportación PDF', 60]],
          [['Registro de ganadores', 40], ['Registro oficial por número, historial y exportación PDF', 60]],
        ],
        GREEN
      ),

      space(3),

      // ── FASE 2 — POR ENTREGAR ─────────────────────────────────────────────

      heading2('FASE 2 — EN DESARROLLO'),
      space(),

      para(run(
        'Los siguientes módulos serán desarrollados durante los próximos meses, en el orden acordado con la gerencia.',
        { size: 11, italic: true, color: '555555' }
      ), { after: 180 }),

      // M4 Financiero
      heading3('Módulo 4 — Financiero'),

      para(run(
        'Gestión del flujo de caja, facturación, pagos a proveedores y vencimientos de la cooperativa.',
        { size: 10, italic: true, color: '666666' }
      ), { after: 100 }),

      mkTable(
        [['Entregable', 40], ['Descripción', 60]],
        [
          [['Flujo de caja', 40], ['Registro de ingresos y egresos, balance por período, proyecciones', 60]],
          [['Control de facturas', 40], ['Registro, seguimiento y estado de facturas emitidas y recibidas', 60]],
          [['Pagos a proveedores', 40], ['Gestión de proveedores, programación de pagos, historial', 60]],
          [['Vencimientos', 40], ['Alertas automáticas de vencimientos próximos, calendario de obligaciones', 60]],
          [['Reportes financieros', 40], ['Exportación de estados financieros por período en Excel y PDF', 60]],
          [['Auditoría', 40], ['Registro de todas las acciones sobre registros financieros con actor y timestamp', 60]],
        ]
      ),

      space(2),

      // M5 Seguros
      heading3('Módulo 5 — Seguros'),

      para(run(
        'Gestión de pólizas de seguros de la cooperativa y sus asociados (familiares, vehiculares, funeraria, entre otros). ' +
        'Conciliación automática entre la base de datos interna y los reportes de las aseguradoras.',
        { size: 10, italic: true, color: '666666' }
      ), { after: 100 }),

      mkTable(
        [['Entregable', 40], ['Descripción', 60]],
        [
          [['Gestión de pólizas', 40], ['Registro y seguimiento de pólizas activas por tipo (familiar, vehicular, funeraria, etc.)', 60]],
          [['Conciliación automática', 40], ['Cruce entre DB interna y reportes de aseguradoras para verificar congruencia de pagos', 60]],
          [['Alertas de inconsistencias', 40], ['Notificación automática cuando lo pagado no coincide con los activos en sistema', 60]],
          [['Portal del asociado', 40], ['Consulta de pólizas activas, coberturas y vigencias desde el portal propio', 60]],
          [['Vencimientos y renovaciones', 40], ['Alertas de pólizas próximas a vencer, historial de renovaciones', 60]],
          [['Reportes', 40], ['Exportación de cartera de seguros por tipo, estado y período', 60]],
        ]
      ),

      space(2),

      // M6 Motor de Estados
      heading3('Módulo 6 — Motor de Estados (Crédito)'),

      para(run(
        'Seguimiento de las etapas del proceso de crédito con auditoría efectiva en cada transición de estado.',
        { size: 10, italic: true, color: '666666' }
      ), { after: 100 }),

      mkTable(
        [['Entregable', 40], ['Descripción', 60]],
        [
          [['Máquina de estados de crédito', 40], ['Definición de etapas del proceso, transiciones válidas y reglas de negocio', 60]],
          [['Seguimiento por solicitud', 40], ['Vista de estado actual, historial completo de etapas y responsables', 60]],
          [['Auditoría de transiciones', 40], ['Registro de quién cambió el estado, cuándo y con qué justificación', 60]],
          [['Alertas y notificaciones', 40], ['Notificación a responsables en cada cambio de etapa', 60]],
          [['Panel de control', 40], ['Vista consolidada de solicitudes por etapa, tiempos promedio y cuellos de botella', 60]],
          [['Reportes de gestión', 40], ['Exportación del estado de cartera de créditos por etapa y período', 60]],
        ]
      ),

      space(2),

      // Módulos por definir
      heading3('Módulos adicionales — Por definir'),

      para(run(
        'Una vez entregados los módulos anteriores, se definirán en conjunto con la gerencia los módulos ' +
        'restantes para completar la cobertura operativa de la cooperativa. Cada módulo adicional se cotizará ' +
        'individualmente según el alcance acordado.',
        { size: 11 }
      ), { after: 80 }),

      space(3),

      // ── RESUMEN ECONÓMICO ─────────────────────────────────────────────────

      heading2('RESUMEN ECONÓMICO'),
      space(),

      mkTable(
        [['Módulo', 55], ['Estado', 20], ['Valor', 25]],
        [
          [['Core del sistema + Migración de datos', 55], ['Entregado ✓', 20, AlignmentType.CENTER], ['$1.300.000 – $2.000.000', 25, AlignmentType.CENTER]],
          [['Sorteos', 55], ['Entregado ✓', 20, AlignmentType.CENTER], ['$500.000 – $800.000', 25, AlignmentType.CENTER]],
          [['Financiero', 55], ['Por desarrollar', 20, AlignmentType.CENTER], ['$1.200.000 – $2.000.000', 25, AlignmentType.CENTER]],
          [['Seguros', 55], ['Por desarrollar', 20, AlignmentType.CENTER], ['$1.500.000 – $2.500.000', 25, AlignmentType.CENTER]],
          [['Motor de Estados — Crédito', 55], ['Por desarrollar', 20, AlignmentType.CENTER], ['$1.200.000 – $1.800.000', 25, AlignmentType.CENTER]],
          [['Módulos adicionales', 55], ['Por definir', 20, AlignmentType.CENTER], ['A cotizar', 25, AlignmentType.CENTER]],
          [['TOTAL ESTIMADO (sin módulos por definir)', 55], ['', 20, AlignmentType.CENTER], ['$5.700.000 – $9.100.000 COP', 25, AlignmentType.CENTER]],
        ]
      ),

      space(),

      para(run(
        '* Los valores de los módulos por desarrollar son estimados y podrán ajustarse según el alcance definitivo acordado con la gerencia.',
        { size: 9, italic: true, color: '888888' }
      ), { after: 80 }),

      space(2),

      // ── CRONOGRAMA ────────────────────────────────────────────────────────

      heading2('CRONOGRAMA ESTIMADO'),
      space(),

      mkTable(
        [['Período', 20], ['Módulo', 40], ['Entregable', 40]],
        [
          [['Mes 1–2', 20], ['Core + Migración + Sorteos', 40], ['Entregado — plataforma base operativa', 40]],
          [['Mes 3', 20], ['Financiero', 40], ['Flujo de caja, facturas, proveedores, vencimientos', 40]],
          [['Mes 4', 20], ['Seguros', 40], ['Gestión de pólizas, conciliación automática, portal asociado', 40]],
          [['Mes 5', 20], ['Motor de Estados', 40], ['Seguimiento de crédito, auditoría de transiciones, reportes', 40]],
          [['Mes 6–7', 20], ['Módulos adicionales', 40], ['Por definir con la gerencia', 40]],
        ]
      ),

      space(3),

      // ── CONDICIONES ───────────────────────────────────────────────────────

      heading2('CONDICIONES COMERCIALES'),
      space(),

      heading3('Modelo de cobro'),
      bullet('50% al inicio de cada módulo · 50% contra entrega funcional'),
      bullet('Evidencia de entrega: repositorios de código en GitHub con historial de commits por funcionalidad'),

      space(),

      heading3('Garantía'),
      bullet('Soporte de bugs sin costo adicional por 30 días calendario post-entrega de cada módulo'),
      bullet('Correcciones de comportamiento y ajustes menores incluidos en el período de garantía'),

      space(),

      heading3('Propiedad intelectual'),
      bullet('El 100% del código fuente es propiedad del cliente al momento del pago final de cada módulo'),
      bullet('El desarrollador no retiene derechos sobre el software entregado'),

      space(3),

      // ── FIRMA ─────────────────────────────────────────────────────────────

      para(run('___________________________________________', { color: '999999' }), { before: 400 }),
      para([run('Alejandro M. Torres', { bold: true })]),
      para(run('Ingeniero de Sistemas y Telecomunicaciones')),
      para(run('Universidad Católica de Pereira')),
      para(run('alejandro.torres0826@gmail.com')),
    ],
  }],
});

const outPath = path.join('scripts', 'Propuesta_Kernel_Cooperativa_Progresemos.docx');
const buffer  = await Packer.toBuffer(doc);
fs.writeFileSync(outPath, buffer);
console.log('Generado:', outPath);
