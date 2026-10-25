/**
 * ===========================================================================
 *  CARNITAS DON LOPE - SERVIDOR POS (server.js)
 * ===========================================================================
 *  Basado en Republic Wings POS - Adaptado para Carnitas Don Lope
 *  
 *  Tecnologías:
 *  - Node.js + Express
 *  - JWT cookies para autenticación
 *  - Google Apps Script como proxy a Google Sheets
 *  - PWA installable con service worker
 *  ===========================================================================
 */

'use strict';

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');

const express = require('express');
const helmet = require('helmet');
const morgan = require('morgan');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

// CLI utility: npm run hash -- "clave"
if (process.argv.includes('--hash')) {
  const clave = process.argv[process.argv.indexOf('--hash') + 1];
  if (!clave) { console.error('Uso: npm run hash -- "tuClaveSecreta"'); process.exit(1); }
  console.log(bcrypt.hashSync(clave, 12));
  process.exit(0);
}

// ===========================================================================
// CONFIGURACION
// ===========================================================================

const PORT = Number(process.env.PORT) || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const ES_PRODUCCION = NODE_ENV === 'production';

const GAS_URL = (process.env.GAS_URL || '').trim();
const MODO_DEMO = !GAS_URL;

const SESSION_SECRET = process.env.SESSION_SECRET || '';
if (!SESSION_SECRET || SESSION_SECRET.length < 24) {
  console.error('\n❌  Falta SESSION_SECRET en .env (mínimo 24 caracteres).\n    Genera uno con: npm run secret\n');
  process.exit(1);
}

const SESSION_HORAS = Number(process.env.SESSION_HORAS) || 12;
const COOKIE_NOMBRE = 'carnitas_session';
const MENU_CACHE_MS = (Number(process.env.MENU_CACHE_SEGUNDOS) || 30) * 1000;

// ===========================================================================
// SUCURSALES (configuradas en .env: SUCURSAL_1_ID, SUCURSAL_1_NOMBRE, etc.)
// ===========================================================================

function cargarSucursales() {
  const lista = [];
  for (let i = 1; i <= 20; i++) {
    const id = process.env[`SUCURSAL_${i}_ID`];
    if (!id) continue;
    lista.push({
      id: id.trim(),
      nombre: (process.env[`SUCURSAL_${i}_NOMBRE`] || id).trim(),
      pass: process.env[`SUCURSAL_${i}_PASS`] || ''
    });
  }
  return lista;
}

const SUCURSALES = cargarSucursales();
if (SUCURSALES.length === 0) {
  console.error('\n❌  No hay sucursales configuradas en .env (SUCURSAL_1_ID, ...)\n');
  process.exit(1);
}

const CLAVES = {
  admin: process.env.CLAVE_ADMIN || '',
  dev: process.env.CLAVE_DEV || '',
  dueno: process.env.CLAVE_DUENO || ''
};

for (const [rol, valor] of Object.entries(CLAVES)) {
  if (!valor) console.warn(`⚠️  CLAVE_${rol.toUpperCase()} no está definida en .env`);
}

// ===========================================================================
// UTILIDADES DE AUTH
// ===========================================================================

function claveCorrecta(ingresada, esperada) {
  if (!esperada || typeof ingresada !== 'string' || ingresada.length === 0) return false;
  if (esperada.startsWith('$2')) {
    try { return bcrypt.compareSync(ingresada, esperada); } catch { return false; }
  }
  const a = Buffer.from(ingresada);
  const b = Buffer.from(esperada);
  const largo = Math.max(a.length, b.length);
  const pa = Buffer.alloc(largo);
  const pb = Buffer.alloc(largo);
  a.copy(pa); b.copy(pb);
  return crypto.timingSafeEqual(pa, pb) && a.length === b.length;
}

function emitirSesion(res, datos) {
  const token = jwt.sign(datos, SESSION_SECRET, { expiresIn: `${SESSION_HORAS}h` });
  res.cookie(COOKIE_NOMBRE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: ES_PRODUCCION,
    maxAge: SESSION_HORAS * 60 * 60 * 1000
  });
}

function leerSesion(req) {
  const token = req.cookies?.[COOKIE_NOMBRE];
  if (!token) return null;
  try { return jwt.verify(token, SESSION_SECRET); } catch { return null; }
}

function agregarRol(req, res, rol) {
  const actual = leerSesion(req) || { sucursalId: null, sucursalNombre: null, roles: [] };
  const roles = Array.from(new Set([...(actual.roles || []), rol]));
  emitirSesion(res, { sucursalId: actual.sucursalId, sucursalNombre: actual.sucursalNombre, roles });
}

function requiereRol(...rolesPermitidos) {
  return (req, res, next) => {
    const sesion = leerSesion(req);
    if (!sesion) return res.status(401).json({ error: 'Sesión no iniciada' });
    const roles = sesion.roles || [];
    if (rolesPermitidos.length > 0 && !rolesPermitidos.some(r => roles.includes(r))) {
      return res.status(403).json({ error: 'Sin permiso' });
    }
    req.sesion = sesion;
    next();
  };
}

function resolverSucursalPedida(sesion, pedida) {
  const roles = sesion.roles || [];
  if (roles.includes('dueno')) {
    return pedida && SUCURSALES.some(s => s.id === pedida) ? pedida : null;
  }
  return sesion.sucursalId;
}

// ===========================================================================
// GOOGLE APPS SCRIPT
// ===========================================================================

const DATA_DIR = path.join(__dirname, 'data');

async function leerJsonLocal(archivo, porDefecto) {
  try {
    const txt = await fsp.readFile(path.join(DATA_DIR, archivo), 'utf8');
    return JSON.parse(txt);
  } catch {
    return porDefecto;
  }
}

async function escribirJsonLocal(archivo, datos) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.writeFile(path.join(DATA_DIR, archivo), JSON.stringify(datos, null, 2), 'utf8');
}

async function gasGet(action, params = {}) {
  const url = new URL(GAS_URL);
  url.searchParams.set('action', action);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), { redirect: 'follow', signal: AbortSignal.timeout(15000) });
  const texto = await res.text();
  try { return JSON.parse(texto); } catch { throw new Error('Apps Script no devolvió JSON válido'); }
}

async function gasPost(action, cuerpo) {
  const url = new URL(GAS_URL);
  if (action) url.searchParams.set('action', action);
  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(cuerpo),
    redirect: 'follow',
    signal: AbortSignal.timeout(15000)
  });
  const texto = await res.text();
  try { return JSON.parse(texto); } catch { throw new Error('Apps Script no devolvió JSON'); }
}

const cacheMenu = new Map();

async function obtenerMenu(sucursalId, forzar = false) {
  const clave = sucursalId || 'GLOBAL';
  const enCache = cacheMenu.get(clave);
  if (!forzar && enCache && enCache.expira > Date.now()) return enCache.datos;

  let datos = MODO_DEMO 
    ? await leerJsonLocal('menu.json', [])
    : (await gasGet('getMenu', { sucursal: sucursalId })).filter || [];
    
  datos = datos.map(normalizarProducto).filter(p => p.id && p.nombre);
  cacheMenu.set(clave, { datos, expira: Date.now() + MENU_CACHE_MS });
  return datos;
}

function normalizarProducto(p) {
  return {
    id: String(p.id ?? p.ID ?? '').trim(),
    nombre: String(p.nombre ?? p.Nombre ?? '').trim(),
    categoria: String(p.categoria ?? p.Categoria ?? '').trim(),
    precio: Number(p.precio ?? p.Precio ?? 0) || 0,
    imagenUrl: p.imagenUrl ?? p.ImagenUrl ?? p.imagen ?? '',
    disponible: p.disponible !== false && p.disponible !== 'false',
    stock: p.stock ?? p.Stock ?? ''
  };
}

function normalizarVenta(v) {
  const nombre = v.cliente ?? v.clienteNombre ?? v.Cliente ?? '';
  const celular = v.clienteCelular ?? v.celular ?? '';
  const totalNum = Number(String(v.total ?? 0).replace(/[^\d.,-]/g, '').replace(',', '.')) || 0;
  return {
    idVenta: v.idVenta ?? v.id ?? v.ID ?? '',
    fecha: v.fecha ?? v.Fecha ?? '',
    cliente: String(nombre).trim() || 'Cliente',
    celular: String(celular).trim(),
    total: `${totalNum.toFixed(2)} Bs`,
    totalNum,
    detalleJson: v.detalleJson ?? v.detalle ?? '',
    metodoPago: v.metodoPago ?? '',
    tipoConsumo: v.tipoConsumo ?? '',
    nota: v.nota ?? '',
    sucursalId: v.sucursalId ?? '',
    sucursalNombre: v.sucursalNombre ?? ''
  };
}

function invalidarCacheMenu() { cacheMenu.clear(); }

// ===========================================================================
// EXPRESS APP
// ===========================================================================

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", 'https://cdn.tailwindcss.com', 'https://unpkg.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https://cdn.tailwindcss.com', 'https://fonts.googleapis.com', 'https://unpkg.com'],
      frameAncestors: ["'none'"],
      objectSrc: ["'none'"]
    }
  },
  crossOriginEmbedderPolicy: false
}));

app.use(compression());
app.use(morgan(ES_PRODUCCION ? 'combined' : 'dev'));
app.use(cookieParser());
app.use(express.json({ limit: '256kb' }));
app.use(express.text({ type: 'text/plain', limit: '256kb' }));

app.use((req, _res, next) => {
  if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
    try { req.body = JSON.parse(req.body); } catch { }
  }
  next();
});

const limitadorLogin = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Demasiados intentos. Espera unos minutos.' }
});

const limitadorApi = rateLimit({ windowMs: 60 * 1000, limit: 240 });
app.use('/api/', limitadorApi);

// ===========================================================================
// RUTAS DE AUTENTICACION
// ===========================================================================

app.post('/api/auth/sucursal', limitadorLogin, (req, res) => {
  const { password, id } = req.body || {};
  const sucursal = SUCURSALES.find(s => s.id === id);
  if (!sucursal || !claveCorrecta(password, sucursal.pass)) {
    return res.status(401).json({ ok: false });
  }
  emitirSesion(res, { sucursalId: sucursal.id, sucursalNombre: sucursal.nombre, roles: ['sucursal'] });
  res.json({ ok: true, sucursal: { id: sucursal.id, nombre: sucursal.nombre } });
});

app.post('/api/auth/admin', limitadorLogin, (req, res) => {
  if (!claveCorrecta(req.body?.password, CLAVES.admin)) return res.status(401).json({ ok: false });
  agregarRol(req, res, 'admin');
  res.json({ ok: true });
});

app.post('/api/auth/dev', limitadorLogin, (req, res) => {
  if (!claveCorrecta(req.body?.password, CLAVES.dev)) return res.status(401).json({ ok: false });
  agregarRol(req, res, 'dev');
  res.json({ ok: true });
});

app.post('/api/auth/dueno', limitadorLogin, (req, res) => {
  if (!claveCorrecta(req.body?.password, CLAVES.dueno)) return res.status(401).json({ ok: false });
  agregarRol(req, res, 'dueno');
  res.json({ ok: true });
});

app.post('/api/auth/salir', (req, res) => {
  res.clearCookie(COOKIE_NOMBRE);
  res.json({ ok: true });
});

app.get('/api/sucursales', (_req, res) => res.json(SUCURSALES.map(s => ({ id: s.id, nombre: s.nombre }))));
app.get('/api/sesion', (req, res) => {
  const sesion = leerSesion(req);
  if (!sesion) return res.json({ autenticado: false });
  res.json({ autenticado: true, sucursalId: sesion.sucursalId, sucursalNombre: sesion.sucursalNombre, roles: sesion.roles || [] });
});

// ===========================================================================
// RUTAS DE MENÚ Y VENTAS
// ===========================================================================

app.get('/api/menu', requiereRol(), async (req, res) => {
  try {
    const sucursalId = resolverSucursalPedida(req.sesion, req.query.sucursal);
    const menu = await obtenerMenu(sucursalId);
    res.json(menu);
  } catch (err) {
    console.error('[menu]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/ventas', requiereRol('sucursal', 'admin', 'dueno'), async (req, res) => {
  try {
    const pedida = req.query.sucursal;
    if (pedida && !req.sesion.roles.includes('dueno') && pedida !== req.sesion.sucursalId) {
      return res.status(403).json({ error: 'Solo ventas de tu sucursal' });
    }
    const ventas = await obtenerVentas(resolverSucursalPedida(req.sesion, pedida));
    res.json(ventas);
  } catch (err) {
    console.error('[ventas]', err.message);
    res.status(502).json({ error: err.message });
  }
});

app.get('/api/dueno/resumen', requiereRol('dueno'), async (_req, res) => {
  try {
    const resultado = {};
    await Promise.all(SUCURSALES.map(async s => {
      try { resultado[s.id] = await obtenerVentas(s.id); }
      catch { resultado[s.id] = []; }
    }));
    res.json(resultado);
  } catch (err) { res.status(502).json({ error: err.message }); }
});

// ===========================================================================
// REGISTRO DE VENTAS
// ===========================================================================

const TIPOS_CONSUMO = ['Para Llevar', 'En el Local'];
const METODOS_PAGO = ['Efectivo', 'Tarjeta', 'QR'];

function recalcularTotal(detalle, menu) {
  let total = 0, completo = true;
  for (const parte of String(detalle).split(' | ')) {
    const m = parte.match(/^(\d+)x\s+([^[]+)/);
    if (!m) { completo = false; continue; }
    const cantidad = parseInt(m[1], 10);
    const nombre = m[2].trim();
    const prod = menu.find(p => p.nombre.trim() === nombre);
    if (!prod) { completo = false; continue; }
    total += cantidad * Number(prod.precio);
  }
  return { total, completo };
}

async function obtenerVentas(sucursalId) {
  let datos;
  if (MODO_DEMO) {
    datos = await leerJsonLocal('ventas.json', []);
    if (sucursalId) datos = datos.filter(v => v.sucursalId === sucursalId);
    return datos.map(normalizarVenta);
  }
  const respuesta = await gasGet('getVentas', { sucursal: sucursalId });
  let lista = Array.isArray(respuesta) ? respuesta : [];
  if (sucursalId) lista = lista.filter(v => !v.sucursalId || v.sucursalId === sucursalId);
  return lista.map(normalizarVenta);
}

app.post('/api/venta', requiereRol('sucursal'), async (req, res) => {
  try {
    const b = req.body || {};
    const clienteNombre = String(b.clienteNombre || '').trim();
    const detalle = String(b.detalleJson || b.detalle || '').trim();
    const tipoConsumo = String(b.tipoConsumo || '').trim();
    const metodoPago = String(b.metodoPago || '').trim();

    if (!clienteNombre) return res.status(400).json({ exito: false, error: 'Falta cliente' });
    if (!detalle) return res.status(400).json({ exito: false, error: 'Orden vacía' });
    if (!METODOS_PAGO.includes(metodoPago)) return res.status(400).json({ exito: false, error: 'Pago inválido' });
    if (!TIPOS_CONSUMO.includes(tipoConsumo)) return res.status(400).json({ exito: false, error: 'Tipo inválido' });

    const menu = await obtenerMenu(req.sesion.sucursalId);
    const { total: totalServidor, completo } = recalcularTotal(detalle, menu);
    const totalCliente = Number(String(b.total || '0').replace(/[^\d.]/g, '').replace(',', '.')) || 0;
    const totalFinal = completo ? totalServidor : totalCliente;

    const venta = {
      total: `${totalFinal.toFixed(2)} Bs`,
      metodoPago, clienteNombre,
      clienteCelular: String(b.clienteCelular || 'N/A').trim().slice(0, 30),
      detalleJson: detalle, tipoConsumo,
      nota: String(b.nota || '').trim().slice(0, 500),
      sucursalId: req.sesion.sucursalId,
      sucursalNombre: req.sesion.sucursalNombre
    };

    if (MODO_DEMO) {
      const ventas = await leerJsonLocal('ventas.json', []);
      const idVenta = `CDL-${String(ventas.length + 1).padStart(4, '0')}`;
      ventas.push({ idVenta, fecha: new Date().toISOString(), ...venta });
      await escribirJsonLocal('ventas.json', ventas);
      invalidarCacheMenu();
      return res.json({ exito: true, idVenta });
    }

    const respuesta = await gasPost(null, venta);
    if (!respuesta || respuesta.exito !== true) return res.status(502).json({ exito: false, error: respuesta?.error || 'Apps Script falló' });
    invalidarCacheMenu();
    res.json({ exito: true, idVenta: respuesta.idVenta });
  } catch (err) {
    console.error('[venta]', err.message);
    res.status(502).json({ exito: false, error: err.message });
  }
});

// ===========================================================================
// PRODUCTOS & STOCK
// ===========================================================================

app.post('/api/productos', requiereRol('dev'), async (req, res) => {
  try {
    const cambios = Array.isArray(req.body?.cambios) ? req.body.cambios : [];
    if (!cambios.length) return res.status(400).json({ exito: false, error: 'Sin cambios' });
    
    const menu = await obtenerMenu(req.sesion.sucursalId, true);
    let actualizados = 0;
    
    for (const c of cambios) {
      const prod = menu.find(p => p.id === String(c.id));
      if (!prod) continue;
      if (c.precio !== undefined) prod.precio = Number(c.precio.toFixed(2));
      if (c.disponible !== undefined) prod.disponible = Boolean(c.disponible);
      if (c.imagenUrl !== undefined) prod.imagenUrl = c.imagenUrl;
      actualizados++;
    }
    
    await escribirJsonLocal('menu.json', menu);
    invalidarCacheMenu();
    res.json({ exito: true, actualizados });
  } catch (err) { console.error('[productos]', err); res.status(502).json({ error: err.message }); }
});

app.post('/api/stock', requiereRol('admin', 'dev'), async (req, res) => {
  // ... same as Republic Wins but adapted
});

// ===========================================================================
// ESTATICOS & HEALTH
// ===========================================================================

app.get('/api/health', (_req, res) => res.json({ ok: true, modo: MODO_DEMO ? 'demo' : 'sheets' }));

const PUBLICOS = {
  '/': 'index.html', '/index.html': 'index.html', '/manifest.json': 'manifest.json',
  '/sw.js': 'sw.js', '/favicon.ico': 'icons/icon-192.png',
  '/icons/icon-192.png': 'icons/icon-192.png', '/icons/icon-512.png': 'icons/icon-512.png'
};

for (const [ruta, archivo] of Object.entries(PUBLICOS)) {
  app.get(ruta, (_req, res) => {
    const completo = path.join(__dirname, archivo);
    if (!fs.existsSync(completo)) return res.status(404).send('No encontrado');
    res.sendFile(completo);
  });
}

app.use((_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use((err, _req, res, _next) => { console.error('[error]', err); res.status(500).json({ error: 'Error interno' }); });

// ===========================================================================
// DEMO MENU
// ===========================================================================

const MENU_DEMO = [
  { id: 'P001', nombre: 'Carnitas (12 pcs)', categoria: 'CARNITAS', precio: 120, imagenUrl: '', disponible: true },
  { id: 'P002', nombre: 'Carnitas (24 pcs)', categoria: 'CARNITAS', precio: 220, imagenUrl: '', disponible: true },
  { id: 'P003', nombre: 'Tacos al Pastor', categoria: 'TACOS', precio: 45, imagenUrl: '', disponible: true },
  { id: 'P004', nombre: 'Quesadilla de Chorizo', categoria: 'QUESADILLAS', precio: 85, imagenUrl: '', disponible: true },
  { id: 'P005', nombre: 'Enchiladas Suizas', categoria: 'ENCHILADAS', precio: 95, imagenUrl: '', disponible: true },
  { id: 'P006', nombre: 'Churros', categoria: 'POSTRES', precio: 40, imagenUrl: '', disponible: true },
  { id: 'P007', nombre: 'Agua 500ml', categoria: 'BEBIDAS', precio: 10, imagenUrl: '', disponible: true, stock: '30' },
  { id: 'P008', nombre: 'Coca Cola 500ml', categoria: 'BEBIDAS', precio: 18, imagenUrl: '', disponible: true, stock: '25' },
  { id: 'P009', nombre: 'Sprite 500ml', categoria: 'BEBIDAS', precio: 18, imagenUrl: '', disponible: true, stock: '20' }
];

// ===========================================================================
// START
// ===========================================================================

app.listen(PORT, () => {
  console.log('\n🔥  CARNITAS DON LOPE — Servidor POS');
  console.log(`    Puerto: ${PORT}`);
  console.log(`    Entorno: ${NODE_ENV}`);
  console.log(`    Origen datos: ${MODO_DEMO ? 'DEMO local' : 'Google Sheets'}`);
  console.log(`    Sucursales: ${SUCURSALES.map(s => s.nombre).join(', ')}\n`);
});