/**
 * ===========================================================================
 *  CARNITAS DON LOPE - Google Apps Script Backend
 * ===========================================================================
 *  Conecta a Google Sheets para el POS de restaurante
 * 
 *  Hojas necesarias:
 *  - Menú: id, nombre, categoria, precio, imagenUrl, disponible
 *  - Ventas: idVenta, fecha, cliente, total, detalleJson, metodoPago, tipoConsumo, nota, sucursalId
 *  - Sucursales: SUCURSAL_N_ID, SUCURSAL_N_NOMBRE, SUCURSAL_N_PASS
 *  - Config: claveAdmin, claveDev, claveDueno, sesionHoras
 *  ===========================================================================
 */

const HojaMenu = 'Menú';
const HojaVentas = 'Ventas';
const HojaSucursales = 'Sucursales';

// ===========================================================================
// UTILIDADES
// ===========================================================================

function obtenerDatos(h) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const hoja = ss.getSheetByName(h);
  if (!hoja) return [];
  const datos = hoja.getDataRange().getValues();
  const encabezados = datos.shift();
  return datos.map(fila => {
    const obj = {};
    encabezados.forEach((col, i) => obj[col] = fila[i]);
    return obj;
  });
}

function guardarDatos(h, datos) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = ss.getSheetByName(h);
  if (!hoja) hoja = ss.insertSheet(h);
  hoja.clear();
  const encabezados = Object.keys(datos[0] || {});
  hoja.getRange(1, 1, 1, encabezados.length).setValues([encabezados]);
  const valores = datos.map(d => encabezados.map(c => d[c]));
  if (valores.length) hoja.getRange(2, 1, valores.length, encabezados.length).setValues(valores);
}

// ===========================================================================
// GET ACTIONS
// ===========================================================================

function doGet(e) {
  const action = e.parameter.action;
  const params = e.parameter;
  
  try {
    switch (action) {
      case 'getMenu':
        return JSON.stringify(getMenu(params.sucursal));
      case 'getVentas':
        return JSON.stringify(getVentas(params.sucursal));
      case 'getSucursales':
        return JSON.stringify(getSucursales());
      case 'getResumen':
        return JSON.stringify(getResumen(params.sucursal));
      case 'health':
        return JSON.stringify({ ok: true, timestamp: new Date().toISOString() });
      default:
        return JSON.stringify({ error: 'Action no reconocido' });
    }
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

// ===========================================================================
// POST ACTIONS
// ===========================================================================

function doPost(e) {
  try {
    // e.postData es objeto con .contents, e.parameter puede ser string o object
    const raw = e.postData?.contents || JSON.stringify(e.parameter || {});
    const cuerpo = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return JSON.stringify(procesarPost(cuerpo));
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

// ===========================================================================
// IMPLEMENTACIONES
// ===========================================================================

function getMenu(sucursalId) {
  let datos = obtenerDatos(HojaMenu);
  datos = datos.filter(p => p.id && p.nombre);
  datos.forEach(p => {
    p.precio = Number(p.precio) || 0;
    p.disponible = p.disponible !== false && p.disponible !== 'false';
    p.imagenUrl = p.imagenUrl || p.imagen || '';
  });
  if (sucursalId) datos = datos.filter(p => p.sucursalId === sucursalId || p.sucursalId === undefined);
  return datos;
}

function getVentas(sucursalId) {
  let datos = obtenerDatos(HojaVentas);
  let idVenta = datos[0]?.idVenta || datos[0]?.id || datos[0]?.ID;
  datos = datos.map(v => ({
    idVenta: v.idVenta || v.id || v.ID || '',
    fecha: v.fecha || v.Fecha || '',
    cliente: v.cliente || v.clienteNombre || '',
    celular: v.clienteCelular || v.celular || v['Cliente Celular'] || '',
    total: v.total || '',
    detalleJson: v.detalleJson || v.detalle || '',
    metodoPago: v.metodoPago || v['Método de Pago'] || '',
    tipoConsumo: v.tipoConsumo || v['Tipo de Consumo'] || '',
    nota: v.nota || '',
    sucursalId: v.sucursalId || '',
    sucursalNombre: v.sucursalNombre || ''
  }));
  if (sucursalId) datos = datos.filter(v => v.sucursalId === sucursalId || v.sucursalId === undefined);
  return datos;
}

function getSucursales() {
  const datos = obtenerDatos(HojaSucursales);
  return datos.filter(s => s.id);
}

function getResumen(sucursalId) {
  const ventas = getVentas(sucursalId);
  const resumen = {
    totalVentas: 0,
    productosMasVendidos: {},
    porcentajeEfectivo: 0,
    porcentajeTarjeta: 0
  };
  
  let totalEfectivo = 0, totalTarjeta = 0, totalQR = 0;
  
  ventas.forEach(v => {
    const total = Number(String(v.total).replace(/[^\d.]/g, '').replace(',', '.')) || 0;
    resumen.totalVentas += total;
    
    if (v.metodoPago === 'Efectivo') totalEfectivo += total;
    else if (v.metodoPago === 'Tarjeta') totalTarjeta += total;
    else if (v.metodoPago === 'QR') totalQR += total;
    
    const detalles = String(v.detalleJson || v.detalle || '').split(' | ');
    detalles.forEach(d => {
      const match = d.match(/^(\d+)x\s+(.+)/);
      if (match) {
        const nombre = match[2].trim();
        resumen.productosMasVendidos[nombre] = (resumen.productosMasVendidos[nombre] || 0) + 1;
      }
    });
  });
  
  const totalPagos = totalEfectivo + totalTarjeta + totalQR;
  if (totalPagos > 0) {
    resumen.porcentajeEfectivo = ((totalEfectivo / totalPagos) * 100).toFixed(1);
    resumen.porcentajeTarjeta = ((totalTarjeta / totalPagos) * 100).toFixed(1);
  }
  
  resumen.productosMasVendidos = Object.entries(resumen.productosMasVendidos)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([nombre, unidades]) => ({ nombre, unidades }));
  
  return resumen;
}

// ===========================================================================
// POST IMPLEMENTACIONES
// ===========================================================================

function procesarPost(cuerpo) {
  const action = cuerpo.action || 'default';
  
  switch (action) {
    case 'registrarVenta':
      return registrarVenta(cuerpo.datos || cuerpo);
    case 'actualizarProductos':
      return actualizarProductos(cuerpo.cambios, cuerpo.sucursal, cuerpo.ventaId);
    case 'actualizarStock':
      return actualizarStock(cuerpo.id, cuerpo.cantidad, cuerpo.sucursal);
    case 'actualizarStockLote':
      return actualizarStockLote(cuerpo.cambios, cuerpo.sucursal);
    default:
      return { exito: false, error: 'Action no reconocido: ' + action };
  }
}

function registrarVenta(venta) {
  const ventas = obtenerDatos(HojaVentas);
  const nuevoId = 'CDL-' + String(ventas.length + 1).padStart(4, '0');
  const nuevaVenta = {
    idVenta: nuevoId,
    fecha: new Date().toISOString(),
    ...venta
  };
  ventas.push(nuevaVenta);
  guardarDatos(HojaVentas, ventas);
  return { exito: true, idVenta: nuevoId };
}

function actualizarProductos(cambios, sucursalId) {
  let menu = obtenerDatos(HojaMenu);
  let actualizados = 0;
  
  cambios.forEach(c => {
    const prod = menu.find(p => String(p.id) === String(c.id));
    if (prod) {
      if (c.precio !== undefined) prod.precio = Number(c.precio.toFixed(2));
      if (c.disponible !== undefined) prod.disponible = Boolean(c.disponible);
      if (c.imagenUrl !== undefined) prod.imagenUrl = c.imagenUrl;
      if (c.categoria !== undefined) prod.categoria = c.categoria;
      actualizados++;
    }
  });
  
  guardarDatos(HojaMenu, menu);
  return { exito: true, actualizados };
}

function actualizarStock(id, cantidad, sucursalId) {
  let menu = obtenerDatos(HojaMenu);
  const prod = menu.find(p => String(p.id) === String(id));
  if (!prod) return { exito: false, error: 'Producto no encontrado' };
  
  prod.stock = (Number(prod.stock) || 0) + Number(cantidad);
  guardarDatos(HojaMenu, menu);
  return { exito: true };
}

function actualizarStockLote(cambios, sucursalId) {
  let menu = obtenerDatos(HojaMenu);
  let actualizados = 0;
  
  cambios.forEach(c => {
    const prod = menu.find(p => String(p.id) === String(c.id));
    if (prod) {
      prod.stock = (Number(prod.stock) || 0) + Number(c.cantidad);
      actualizados++;
    }
  });
  
  guardarDatos(HojaMenu, menu);
  return { exito: true, actualizados };
}

// ===========================================================================
// MENU DE PRUEBA (setup inicial)
// ===========================================================================

function crearMenuDemo() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = ss.getSheetByName('Menú');
  if (!hoja) hoja = ss.insertSheet('Menú');
  
  const productos = [
    ['id', 'nombre', 'categoria', 'precio', 'imagenUrl', 'disponible', 'stock'],
    ['P001', 'Carnitas (12 pcs)', 'CARNITAS', 120, '', true, ''],
    ['P002', 'Carnitas (24 pcs)', 'CARNITAS', 220, '', true, ''],
    ['P003', 'Tacos al Pastor', 'TACOS', 45, '', true, ''],
    ['P004', 'Quesadilla de Chorizo', 'QUESADILLAS', 85, '', true, ''],
    ['P005', 'Enchiladas Suizas', 'ENCHILADAS', 95, '', true, ''],
    ['P006', 'Churros', 'POSTRES', 40, '', true, ''],
    ['P007', 'Agua Mineral 500ml', 'BEBIDAS', 10, '', true, '30'],
    ['P008', 'Coca Cola 500ml', 'BEBIDAS', 18, '', true, '25'],
    ['P009', 'Sprite 500ml', 'BEBIDAS', 18, '', true, '20'],
    ['P010', 'Jarabe de Tamarindo', 'BEBIDAS', 20, '', true, '15']
  ];
  
  hoja.getRange(1, 1, productos.length, productos[0].length).setValues(productos);
  SpreadsheetApp.flush();
}

function crearVentasDemo() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = ss.getSheetByName('Ventas');
  if (!hoja) hoja = ss.insertSheet('Ventas');
  
  const encabezados = ['idVenta', 'fecha', 'cliente', 'celular', 'total', 'detalleJson', 'metodoPago', 'tipoConsumo', 'nota', 'sucursalId', 'sucursalNombre'];
  hoja.getRange(1, 1, 1, encabezados.length).setValues([encabezados]);
  SpreadsheetApp.flush();
}

function crearSucursalesDemo() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let hoja = ss.getSheetByName('Sucursales');
  if (!hoja) hoja = ss.insertSheet('Sucursales');
  
  const datos = [
    ['id', 'nombre', 'pass'],
    ['carnitas-principal', 'Principal', 'clave123']
  ];
  
  hoja.getRange(1, 1, datos.length, datos[0].length).setValues(datos);
  SpreadsheetApp.flush();
}