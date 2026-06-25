# Kernel Backend — Cooperativa Progresemos

API REST construida con **Express (ESM)** + **PostgreSQL** + **Socket.IO**. Gestiona la operativa de la cooperativa: asociados, sorteos, notificaciones y administración de usuarios.

---

## Stack

| Capa | Tecnología |
|---|---|
| Runtime | Node.js (ESM `import/export`) |
| Framework | Express 4 |
| Base de datos | PostgreSQL via `pg` (pool compartido) |
| Auth | JWT en cookies HttpOnly |
| Real-time | Socket.IO |
| Validación | Zod |
| Logging | Winston |
| Migraciones | node-pg-migrate (`.cjs`) |
| Tests | Jest + Supertest |

---

## Requisitos

- Node.js 18+
- PostgreSQL 15+ (Docker recomendado)
- `.env` configurado (ver sección abajo)

---

## Variables de entorno

```env
DATABASE_URL=postgresql://usuario:password@localhost:5435/kernel
JWT_SECRET=min16caracteres
PORT=4000
NODE_ENV=development
FRONTEND_URL=http://localhost:5173

# Solo para script de migración desde Railway
PLATINUM_DATABASE_URL=...  # nunca commitear
```

---

## Instalación y arranque

```bash
npm install
npm run migrate:up   # aplicar migraciones pendientes
npm run dev          # nodemon en puerto 4000
```

---

## Comandos disponibles

```bash
npm run dev                              # desarrollo con nodemon
npm run migrate:up                       # aplicar migraciones
npm run migrate:down                     # revertir última migración
npm run migrate:create -- nombre         # crear archivo de migración
npm test                                 # suite completa Jest + Supertest
npm test -- --testPathPattern=modulo     # módulo específico
```

---

## Arquitectura

```
src/
  config/
    env.js                  # schema Zod de variables de entorno
  db/
    database.js             # pool pg compartido
  middlewares/
    auth.js                 # verifyToken (empleados)
    authAsociado.js         # verifyAsociado (portal)
    checkPermission.js      # ACL granular por módulo+acción
    errorHandler.js         # manejo centralizado de errores
    rateLimiter.js          # 10 intentos / 15 min en login
  modules/
    auth/                   # login/logout/register empleados
    admin/                  # gestión usuarios, permisos, auditoría
    asociados/              # padrón asociados + portal auth
    empresas/               # listado empresas
    perfil/                 # perfil del empleado
    sorteos/                # sorteos, boletos, solicitudes, ganadores
    notificaciones/         # notificaciones persistentes empleados
  services/
    notificationService.js  # notificarUsuario/Asociado/PorPermiso/Admins
  index.js                  # loader dinámico de módulos + HTTP server + Socket.IO
migrations/                 # node-pg-migrate .cjs
scripts/
  migrate_platinum.js       # sync desde Railway (uso manual)
tests/
  integration/              # un archivo por módulo, contra DB real
```

El loader dinámico en `index.js` escanea `src/modules/*/routes/*Routes.js` y monta cada módulo en `/api/<nombre>` automáticamente.

---

## Módulos y endpoints

### `auth` — `/api/auth`
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/login` | Login empleado (rate limited) |
| POST | `/logout` | Cierra sesión |
| POST | `/register` | Registro (requiere aprobación admin) |
| GET | `/me` | Datos del usuario autenticado |

### `admin` — `/api/admin`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/usuarios` | Listado de empleados |
| PATCH | `/usuarios/:id/aprobar` | Aprobar registro |
| PATCH | `/usuarios/:id/desactivar` | Desactivar usuario |
| PATCH | `/usuarios/:id/reactivar` | Reactivar usuario |
| PATCH | `/usuarios/:id/rol` | Cambiar rol |
| PATCH | `/usuarios/:id/password` | Resetear contraseña |
| PATCH | `/asociados/:codigo/password` | Resetear contraseña de asociado |
| POST | `/permisos/asignar-masivo` | Asignar permisos en bloque |
| GET | `/metricas` | KPIs para el selector |
| GET | `/logs` | Auditoría de acciones admin |

### `asociados` — `/api/asociados`
| Método | Ruta | Descripción |
|---|---|---|
| POST | `/login` | Login asociado por CC (rate limited) |
| POST | `/logout` | Cierra sesión portal |
| GET | `/me` | Datos del asociado autenticado |
| POST | `/importar` | Sincronización CSV padrón |
| GET | `/sincronizaciones` | Historial de sincronizaciones |
| GET | `/notificaciones` | Notificaciones del asociado |
| PATCH | `/notificaciones/:id/leer` | Marcar una como leída |
| PATCH | `/notificaciones/leer-todas` | Marcar todas como leídas |
| PUT | `/password` | Cambiar contraseña propia |

### `sorteos` — `/api/sorteos`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | Listar sorteos |
| POST | `/` | Crear sorteo (pre-pobla 1000 boletos) |
| PUT | `/:id/estado` | Toggle activo/pausado |
| GET | `/:id/boletos` | Grilla de boletos |
| POST | `/:id/boletos/asignar` | Asignación directa |
| POST | `/:id/boletos/retirar` | Retiro directo |
| GET | `/:id/solicitudes` | Solicitudes pendientes |
| POST | `/:id/solicitudes/:sid/aprobar` | Aprobar solicitud |
| POST | `/:id/solicitudes/:sid/rechazar` | Rechazar solicitud |
| POST | `/:id/empresas/:codigo` | Toggle empresa habilitada |
| POST | `/:id/ganador` | Registrar ganador |
| GET | `/:id/ganadores` | Listar ganadores |
| GET | `/:id/logs` | Auditoría de acciones |
| GET | `/:id/asociados` | Participantes con boletos activos |
| GET | `/:id/asociados/:codigo/historial` | Historial de un asociado en el sorteo |
| GET | `/:id/estadisticas` | Dashboard de métricas y gráficas |
| GET | `/portal/activo` | Sorteo activo (portal asociado) |
| POST | `/portal/solicitar` | Solicitar bono (portal) |
| POST | `/portal/solicitar-retiro` | Solicitar retiro (portal) |
| DELETE | `/portal/solicitudes/:sid` | Cancelar solicitud (portal) |

### `notificaciones` — `/api/notificaciones`
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/` | Notificaciones del empleado (filtradas por permisos) |
| PATCH | `/:id/leer` | Marcar como leída |
| PATCH | `/leer-todas` | Marcar todas como leídas |

---

## Base de datos

### Tablas principales

| Tabla | Descripción |
|---|---|
| `global_usuarios` | Empleados (`is_active`, `is_approved`, `rol`) |
| `modulos`, `acciones`, `permisos` | ACL granular |
| `asociados` | Padrón (PK: `codigo` = CC), `fecha_ingreso`, `fecha_retiro` |
| `empresas` | Empresas de descuento |
| `sincronizaciones` | Auditoría CSV |
| `sorteos` | Estado: `activo` \| `pausado` |
| `sorteo_empresas` | Empresas habilitadas por sorteo |
| `boletos` | PK compuesta `(numero, sorteo_id)`, `fecha_asignacion` |
| `solicitudes_bono` | Solicitudes adquisición/retiro |
| `sorteo_logs` | Auditoría completa de boletos |
| `sorteo_ganadores` | Ganadores oficiales |
| `notificaciones` | Una fila por notif; `usuario_uuid` XOR `asociado_codigo` |
| `admin_logs` | Acciones admin auditadas |

### Reglas de diseño

- PKs siempre **UUID** (`uuid_generate_v4()`), excepto `boletos` y `asociados`
- **Borrado lógico** — `is_active = false`, nunca `DELETE` en entidades de negocio
- Timestamps: `created_at TIMESTAMPTZ DEFAULT NOW()`

### Índices de performance

```sql
idx_boletos_sorteo_asociado  ON boletos(sorteo_id, asociado_codigo)
idx_boletos_sorteo_estado    ON boletos(sorteo_id, estado)
idx_sorteo_logs_sorteo_numero ON sorteo_logs(sorteo_id, numero)
idx_sorteo_logs_sorteo_fecha  ON sorteo_logs(sorteo_id, created_at)
```

---

## Sistema de notificaciones (Socket.IO)

El servidor levanta un `httpServer` sobre Express y adjunta Socket.IO. La autenticación se hace parseando la cookie JWT en el middleware del socket.

**Rooms:**
- `user:{uuid}` — notificaciones personales del empleado
- `role:admin` — alertas para todos los admins
- `asociado:{codigo}` — notificaciones del portal

**Funciones disponibles (`notificationService.js`):**

```js
notificarUsuario(usuario_uuid, { tipo, mensaje, modulo })
notificarAsociado(asociado_codigo, { tipo, mensaje, modulo })
notificarPorPermiso(modulo, { tipo, mensaje })  // todos con READ en ese módulo
notificarAdmins({ tipo, mensaje, modulo })
```

Siempre usar en fire-and-forget: `.catch(() => {})`.

---

## Seguridad

- Rate limiting en ambos endpoints de login: 10 intentos / 15 minutos
- Todas las rutas de empleados pasan por `verifyToken` + `checkPermission`
- Rutas del portal pasan por `verifyAsociado` (declaradas antes del `router.use(verifyToken)`)
- `admin_logs` audita: `APROBAR_USUARIO`, `DESACTIVAR_USUARIO`, `REACTIVAR_USUARIO`, `CAMBIAR_ROL`, `RESET_PASSWORD`, `RESET_PASSWORD_ASOCIADO`, `ASIGNAR_PERMISOS`

---

## Migraciones (14)

| # | Archivo | Contenido |
|---|---|---|
| 1 | `1719187200000_init` | Tablas base + ACL |
| 2 | `1719187200001_seed` | Usuario admin seed |
| 3 | `1719187200002_modulo_admin` | Módulo admin |
| 4 | `1719187200003_asociados` | Tabla asociados |
| 5 | `1719187200004_modulo_asociados` | Módulo asociados |
| 6 | `1719187200005_auditoria_sincronizaciones` | Tabla sincronizaciones |
| 7 | `1719187200006_fechas_asociado` | `fecha_ingreso`, `fecha_retiro` |
| 8 | `1719187200007_empresas` | Tabla empresas |
| 9 | `1719187200008_modulo_perfil` | Módulo perfil |
| 10 | `1719187200009_sorteos` | Tablas módulo sorteos |
| 11 | `1719187200010_modulo_sorteos` | Módulo sorteos en ACL |
| 12 | `1782403636325_notificaciones` | Tabla notificaciones |
| 13 | `1782404781601_admin-logs` | Tabla admin_logs |
| 14 | `1782500000000_boletos-indexes` | Índices performance |

---

## Script de sincronización Railway

Migra datos desde la plataforma antigua (Railway/Platinum) al sistema Kernel.

```bash
node scripts/migrate_platinum.js              # dry-run (solo muestra)
node scripts/migrate_platinum.js --run        # sync incremental
node scripts/migrate_platinum.js --run --clean  # limpia y re-sincroniza todo
```

Requiere `PLATINUM_DATABASE_URL` en `.env`. **Nunca hardcodear la URL.**

---

## Tests

```bash
npm test                                      # todos los módulos
npm test -- --testPathPattern=sorteos         # módulo específico
```

- Integración real contra PostgreSQL (sin mocks de BD)
- `request.agent(app)` mantiene cookie JWT entre tests
- `beforeAll` crea usuario + permisos + seed · `afterAll` limpia en orden FK
