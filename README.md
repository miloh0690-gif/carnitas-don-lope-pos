# Carnitas Don Lope - POS System

Sistema POS para restaurante multi-sucursal, inspirado en Republic Wins POS.

## 🚀 Quick Start

```bash
# 1. Clone y entra al proyecto
git clone <repo-url>
cd CarnitasDonLope

# 2. Instala dependencias
npm install

# 3. Copia .env.example a .env y completa los valores
cp .env.example .env
# Edita .env con tus credenciales de Google Apps Script

# 4. Genera claves seguras
npm run secret  # para SESSION_SECRET
npm run hash -- "mi_clave_segura"  # para claves de acceso

# 5. Inicia el servidor
npm start
# Visita http://localhost:3000
```

## 📋 Google Sheets Required

Crea estas hojas en tu Google Sheets:

### Hoja: Menú
| id | nombre | categoria | precio | imagenUrl | disponible | stock |
|----|--------|-----------|--------|-----------|------------|-------|
| P001 | Carnitas (12 pcs) | CARNITAS | 120 | https://drive.google/uc?id=... | true | |

### Hoja: Ventas
| idVenta | fecha | cliente | total | detalleJson | metodoPago | tipoConsumo | sucursalId |
|---------|-------|---------|-------|-------------|------------|-------------|------------|

### Hoja: Sucursales
| id | nombre | pass |
|----|--------|------|
| carnitas-principal | Principal | hash_bcrypt |

## 🔗 Google Apps Script Code

El archivo `Code.gs` va en tu proyecto de Apps Script:

1. Ve a https://script.google.com
2. Crea nuevo proyecto
3. Pega el contenido de `Code.gs`
4. Publica > Deploy > Nueva implementación > Web app
5. Ejecuta como: "Cualquier usuario"
6. URL de acceso: copia la URL /exec
7. Pega la URL en `.env` como `GAS_URL`

## 🚀 Deploy a Render

```bash
# 1. Conecta tu repo a Render
# 2. Build command: npm install
# 3. Start command: npm start
# 4. Puerto recomendado: 10000
# 5. Añade variables de entorno desde el dashboard

# Alternativa: Deploy manual
git remote add render <render-url>
git push render main
```

## 🔐 Roles y Permisos

| Rol | Descripción | Endpoints |
|-----|-------------|-----------|
| sucursal | Acceso a ventas de su sucursal | `/api/menu`, `/api/venta`, `/api/ventas` |
| admin | Gestión de inventario | `/api/stock`, `/api/productos` |
| dev | Actualización de precios | `/api/productos` |
| dueno | Panel consolidado | `/api/dueno/resumen` |

## 📦 Estructura

```
CarnitasDonLope/
├── index.html          # Frontend POS
├── server.js           # Backend Express
├── Code.gs             # Google Apps Script
├── package.json
├── .env.example
└── data/               # Solo para modo demo
    ├── menu.json
    └── ventas.json
```

## 🎨 Personalización

- Colores: Edita `:root` en `index.html`
- Estilo: Usa las clases Tailwind desde CDN
- Logo: Reemplaza `Emblema de Carnitas Don Lope.png`

## 📱 PWA Instalable

El sistema es una PWA – agrega a pantalla de inicio desde móvil:
- Manifest incluido
- Service worker registra vistas offline
- Datos se sincronizan al reconectar