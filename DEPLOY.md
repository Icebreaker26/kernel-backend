# Deploy en Railway — Cooperativa Progresemos

Guía paso a paso para desplegar Kernel en Railway con dos subdominios:
- `kernel.cooperativaprogresemos.coop` → Portal de empleados
- `portal.cooperativaprogresemos.coop` → Portal del asociado
- `api.cooperativaprogresemos.coop` → Backend (API)

---

## Prerequisitos

- Cuenta en [Railway](https://railway.app)
- Acceso al panel DNS del dominio `cooperativaprogresemos.coop`
- Repositorio en GitHub conectado a Railway

---

## 1. Crear el proyecto en Railway

1. Entra a [railway.app](https://railway.app) → **New Project**
2. Selecciona **Deploy from GitHub repo** y elige el repositorio
3. Railway detectará el monorepo — por ahora cierra sin configurar, lo harás manualmente

---

## 2. Servicio — Base de datos (PostgreSQL)

1. En el proyecto → **New** → **Database** → **PostgreSQL**
2. Railway crea la base de datos y expone la variable `DATABASE_URL` automáticamente
3. Anota el valor de `DATABASE_URL` (lo necesitarás para el backend)

---

## 3. Servicio — Backend

### 3.1 Crear el servicio

1. **New** → **GitHub Repo** → selecciona el repo
2. En **Settings** del servicio:
   - **Root Directory**: `backend`
   - **Build Command**: `npm install`
   - **Start Command**: `npm run migrate:up && node src/index.js`

> El `migrate:up` antes del start garantiza que las migraciones estén al día en cada deploy.

### 3.2 Variables de entorno

En la pestaña **Variables** del servicio backend, agrega:

| Variable | Valor |
|---|---|
| `DATABASE_URL` | *(copiar desde el servicio PostgreSQL)* |
| `JWT_SECRET` | *(cadena aleatoria, mín. 32 caracteres)* |
| `NODE_ENV` | `production` |
| `PORT` | `4000` |
| `FRONTEND_URL` | `https://kernel.cooperativaprogresemos.coop` |
| `PORTAL_URL` | `https://portal.cooperativaprogresemos.coop` |

> Para generar un JWT_SECRET seguro: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`

### 3.3 Dominio personalizado

1. En **Settings** → **Networking** → **Custom Domain**
2. Agrega: `api.cooperativaprogresemos.coop`
3. Railway mostrará el CNAME de destino — anótalo

---

## 4. Servicio — Frontend

### 4.1 Crear el servicio

1. **New** → **GitHub Repo** → selecciona el mismo repo
2. En **Settings** del servicio:
   - **Root Directory**: `frontend`
   - **Build Command**: `npm install && npm run build`
   - **Start Command**: *(dejar vacío — Railway sirve el `dist/` como estático)*

> Si Railway no detecta automáticamente que es un sitio estático, en **Settings** → **Deploy** activa **Static Site** y apunta a `dist`.

### 4.2 Variables de entorno

| Variable | Valor |
|---|---|
| `VITE_API_BASE_URL` | `https://api.cooperativaprogresemos.coop/api` |

### 4.3 Dos dominios personalizados

En **Settings** → **Networking** → **Custom Domain**, agrega **los dos**:

1. `kernel.cooperativaprogresemos.coop`
2. `portal.cooperativaprogresemos.coop`

Railway mostrará el mismo CNAME de destino para ambos — anótalo.

---

## 5. Configurar el DNS

En el panel DNS de tu registrador (GoDaddy, Namecheap, Cloudflare, etc.) crea estos registros:

| Tipo | Nombre | Destino |
|---|---|---|
| `CNAME` | `kernel` | CNAME del servicio frontend (ej: `kernel-frontend.railway.app`) |
| `CNAME` | `portal` | CNAME del servicio frontend *(el mismo)* |
| `CNAME` | `api` | CNAME del servicio backend (ej: `kernel-backend.railway.app`) |

> Los cambios DNS pueden tardar entre 5 minutos y 48 horas en propagarse.

---

## 6. Verificar el deploy

Una vez propagado el DNS:

```bash
# Verifica que el backend responde
curl https://api.cooperativaprogresemos.coop/api/auth/me
# Esperado: {"error":"No autorizado"} con status 401

# Verifica los frontends
# Abre en el navegador:
# https://kernel.cooperativaprogresemos.coop  → debe mostrar el Landing de empleados
# https://portal.cooperativaprogresemos.coop  → debe redirigir al login del portal
```

---

## 7. Primer uso en producción

1. Inicia sesión en `kernel.cooperativaprogresemos.coop` con las credenciales del seed:
   - Email: `alejandro.torres0826@gmail.com`
   - Password: `kernel2026`
2. **Cambia la contraseña inmediatamente** desde Mi Perfil
3. Importa el CSV de asociados desde Administración → Asociados → Importar CSV
4. Activa el portal para cada asociado que lo requiera desde la columna Portal en la tabla de asociados

---

## Variables de entorno — resumen completo

### Backend (`.env` local / Railway Variables)

```env
DATABASE_URL=postgresql://user:pass@host:5432/kernel
JWT_SECRET=cambia_esto_por_una_cadena_aleatoria_segura
PORT=4000
NODE_ENV=production
FRONTEND_URL=https://kernel.cooperativaprogresemos.coop
PORTAL_URL=https://portal.cooperativaprogresemos.coop
```

### Frontend (`.env` local / Railway Variables)

```env
VITE_API_BASE_URL=https://api.cooperativaprogresemos.coop/api
```

---

## Troubleshooting

**El frontend carga pero las llamadas a la API fallan con CORS**
- Verifica que `FRONTEND_URL` y `PORTAL_URL` en el backend coincidan exactamente con los dominios (con `https://`, sin `/` al final)

**Las cookies no se envían (401 en todas las rutas protegidas)**
- En producción las cookies requieren `https`. Verifica que Railway haya emitido el certificado SSL para los dominios personalizados (aparece en Settings → Networking como un candado verde)
- Si el backend y el frontend están en dominios raíz distintos (ej. backend en `.railway.app` y frontend en `.coop`), cambia `sameSite: 'lax'` a `sameSite: 'none'` en los controllers de auth

**El portal muestra rutas de empleados (o viceversa)**
- Verifica que el hostname del subdominio empiece exactamente con `portal.` — la detección en `App.jsx` usa `hostname.startsWith('portal.')`

**Las migraciones fallan al arrancar**
- Verifica que `DATABASE_URL` apunte a la base de datos correcta
- Ejecuta manualmente desde Railway CLI: `railway run npm run migrate:up`
