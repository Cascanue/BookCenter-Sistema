
const rolActual = localStorage.getItem('rolUsuario');
if (!rolActual) { window.location.href = '/'; }
else if (rolActual !== 'administrador') { alert('Acceso denegado: Solo administradores.'); window.location.href = '/menu'; }

let categorias = [], productos = [], clientes = [], pedidos = [], comprobantes = [];
let productoEditar = null, clienteEditar = null;

function cambiarVista(n) {
  document.querySelectorAll('.vista').forEach(v => v.classList.remove('activa'));
  document.querySelectorAll('.btn-sidebar').forEach(b => b.classList.remove('activo'));
  document.getElementById('vista-' + n).classList.add('activa');
  document.getElementById('nav-' + n).classList.add('activo');
}

function cerrarModal(id) { document.getElementById(id).classList.add('oculto'); }
document.querySelectorAll('.modal-overlay').forEach(o => o.addEventListener('click', function(e) { if (e.target === this) cerrarModal(this.id); }));

// ===============================================
// CARGAS DESDE LA BASE DE DATOS (API REST)
// ===============================================
async function cargarCategorias() {
  const res = await fetch(URL_BACKEND + '/api/categorias');
  categorias = await res.json();
}

async function cargarResumen() {
  const res = await fetch(URL_BACKEND + '/api/admin/resumen');
  const data = await res.json();
  document.getElementById('kpi-productos').textContent = data.totalProductos;
  document.getElementById('kpi-clientes').textContent = data.totalClientes;
  document.getElementById('kpi-pedidos').textContent = data.totalPedidos;
  document.getElementById('kpi-stock-critico').textContent = data.stockCritico;
  document.getElementById('badge-critico').textContent = data.stockCritico;
  
  const resProd = await fetch(URL_BACKEND + '/api/productos');
  const prods = await resProd.json();
  const cr = prods.filter(p => p.stock_actual <= p.stock_minimo);
  const tb = document.getElementById('body-stock-critico');
  if (!cr.length) { tb.innerHTML = '<tr><td colspan="6"><div class="estado-vacio"><i class="bx bx-check-circle"></i>Sin alertas de stock</div></td></tr>'; return; }
  tb.innerHTML = cr.map(p => {
    const c = categorias.find(x => x.id_categoria === p.id_categoria);
    return '<tr class="fila-alerta"><td><b>'+p.codigo+'</b></td><td>'+p.nombre+'</td><td>'+(c ? c.nombre : '-')+'</td><td><b style="color:var(--rojo)">'+p.stock_actual+'</b></td><td>'+p.stock_minimo+'</td><td><span class="badge badge-rojo">Stock Bajo</span></td></tr>';
  }).join('');
}

async function cargarProductos() {
  const res = await fetch(URL_BACKEND + '/api/productos');
  productos = await res.json();
  renderProductos();
}

function renderProductos(lista) {
  const data = lista || productos;
  const tb = document.getElementById('body-productos');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="8"><div class="estado-vacio"><i class="bx bx-package"></i>Sin resultados</div></td></tr>'; return; }
  tb.innerHTML = data.map(p => {
    const cat = categorias.find(c => c.id_categoria === p.id_categoria);
    const bajo = p.stock_actual <= p.stock_minimo;
    const bs = bajo ? '<span class="badge badge-rojo">'+p.stock_actual+'</span>' : '<span class="badge badge-verde">'+p.stock_actual+'</span>';
    const nm = p.nombre.replace(/'/g, "\\'");
    return '<tr class="'+(bajo?'fila-alerta':'')+'"><td><img src="'+(p.url_imagen||'')+'" class="img-miniatura" onerror="this.src=\'https://placehold.co/40x40\'"></td><td><code>'+p.codigo+'</code></td><td><b>'+p.nombre+'</b></td><td>'+(cat?cat.nombre:'-')+'</td><td><b>S/ '+parseFloat(p.precio_venta).toFixed(2)+'</b></td><td>'+bs+'</td><td><span class="badge badge-verde">Activo</span></td><td><div class="acciones-fila"><button class="btn-accion editar" title="Editar" onclick="abrirModalProducto('+p.id_producto+')"><i class="bx bx-edit"></i></button><button class="btn-accion eliminar" title="Eliminar" onclick="confirmarEliminar(\'producto\','+p.id_producto+',\''+nm+'\')"><i class="bx bx-trash"></i></button></div></td></tr>';
  }).join('');
}

function filtrarProductos() { const q = document.getElementById('buscador-productos').value.toLowerCase(); renderProductos(productos.filter(p => p.nombre.toLowerCase().includes(q) || p.codigo.toLowerCase().includes(q))); }

async function cargarClientes() {
  const res = await fetch(URL_BACKEND + '/api/clientes');
  clientes = await res.json();
  renderClientes();
}

function renderClientes(lista) {
  const data = lista || clientes;
  const tb = document.getElementById('body-clientes');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="6"><div class="estado-vacio"><i class="bx bx-group"></i>Sin resultados</div></td></tr>'; return; }
  tb.innerHTML = data.map(c => '<tr><td><span class="badge badge-azul">'+c.tipo_documento+'</span></td><td>'+c.num_documento+'</td><td><b>'+c.nombre+'</b></td><td>'+(c.telefono||'-')+'</td><td>'+(c.correo||'-')+'</td><td><div class="acciones-fila"><button class="btn-accion editar" title="Editar" onclick="abrirModalCliente('+c.id_cliente+')"><i class="bx bx-edit"></i></button><button class="btn-accion eliminar" title="Eliminar" onclick="confirmarEliminar(\'cliente\','+c.id_cliente+',\''+c.nombre.replace(/'/g, "\\'")+'\')"><i class="bx bx-trash"></i></button></div></td></tr>').join('');
}

function filtrarClientes() { const q = document.getElementById('buscador-clientes').value.toLowerCase(); renderClientes(clientes.filter(c => c.nombre.toLowerCase().includes(q) || c.num_documento.includes(q))); }

async function cargarPedidos() {
  const res = await fetch(URL_BACKEND + '/api/admin/pedidos');
  pedidos = await res.json();
  renderPedidos();
}

function renderPedidos(lista) {
  const data = lista || pedidos;
  const tb = document.getElementById('body-pedidos');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="6"><div class="estado-vacio"><i class="bx bx-cart"></i>Sin resultados</div></td></tr>'; return; }
  tb.innerHTML = data.map(p => {
    const bs = p.estado === 'Completado' ? '<span class="badge badge-verde">'+p.estado+'</span>' : (p.estado === 'Anulado' ? '<span class="badge badge-rojo">'+p.estado+'</span>' : '<span class="badge badge-amarillo">'+p.estado+'</span>');
    const d = p.fecha_pedido ? new Date(p.fecha_pedido).toLocaleDateString('es-PE') : '-';
    const nombreCompleto = (p.nombres+' '+p.apellido_paterno).trim();
    return '<tr><td><b>#'+p.id_pedido+'</b></td><td>'+nombreCompleto+'</td><td>'+d+'</td><td><b>S/ '+parseFloat(p.total).toFixed(2)+'</b></td><td>'+bs+'</td><td><div class="acciones-fila"><button class="btn-accion ver" title="Ver detalle" onclick="verDetallePedido('+p.id_pedido+', \''+nombreCompleto+'\', \''+d+'\', \''+p.estado+'\', '+p.total+')"><i class="bx bx-show"></i></button></div></td></tr>';
  }).join('');
}

function filtrarPedidos() { const q = document.getElementById('buscador-pedidos').value.toLowerCase(); renderPedidos(pedidos.filter(p => String(p.id_pedido).includes(q) || (p.nombres+' '+p.apellido_paterno).toLowerCase().includes(q))); }

async function cargarComprobantes() {
  const res = await fetch(URL_BACKEND + '/api/admin/comprobantes');
  comprobantes = await res.json();
  renderComprobantes();
}

function renderComprobantes(lista) {
  const data = lista || comprobantes;
  const tb = document.getElementById('body-comprobantes');
  if (!data.length) { tb.innerHTML = '<tr><td colspan="7"><div class="estado-vacio"><i class="bx bx-receipt"></i>Sin resultados</div></td></tr>'; return; }
  tb.innerHTML = data.map(c => {
    const isAnulado = c.estado === 'Anulado';
    const bs = !isAnulado ? '<span class="badge badge-verde">Vigente</span>' : '<span class="badge badge-rojo">Anulado</span>';
    const btnA = !isAnulado ? '<button class="btn-accion anular" title="Anular" onclick="confirmarAnular('+c.id_pedido+','+c.id_comprobante+',\''+c.numero_correlativo+'\')"><i class="bx bx-block"></i></button>' : '';
    const d = c.fecha_emision ? new Date(c.fecha_emision).toLocaleDateString('es-PE') : '-';
    return '<tr><td><b>'+c.numero_correlativo+'</b></td><td><span class="badge badge-azul">'+c.tipo_comprobante+'</span></td><td>Pedido #'+c.id_pedido+'</td><td>'+d+'</td><td><b>S/ '+parseFloat(c.monto_total).toFixed(2)+'</b></td><td>'+bs+'</td><td><div class="acciones-fila"><button class="btn-accion ver" title="Ver detalle" onclick="verDetallePedido('+c.id_pedido+')"><i class="bx bx-show"></i></button>'+btnA+'</div></td></tr>';
  }).join('');
}

function filtrarComprobantes() { const q = document.getElementById('buscador-comprobantes').value.toLowerCase(); renderComprobantes(comprobantes.filter(c => c.numero_correlativo.toLowerCase().includes(q) || String(c.id_pedido).includes(q))); }

// ===============================================
// ACCIONES Y MODALES
// ===============================================

function abrirModalProducto(id) {
  productoEditar = id ? productos.find(p => p.id_producto === id) : null;
  document.getElementById('titulo-modal-producto').textContent = productoEditar ? 'Editar Producto' : 'Nuevo Producto';
  const sel = document.getElementById('producto-categoria');
  sel.innerHTML = '<option value="">- Seleccionar -</option>' + categorias.map(c => '<option value="'+c.id_categoria+'">'+c.nombre+'</option>').join('');
  const preview = document.getElementById('producto-imagen-preview');
  document.getElementById('producto-imagen-file').value = '';
  if (productoEditar) {
    document.getElementById('producto-id').value = productoEditar.id_producto;
    document.getElementById('producto-codigo').value = productoEditar.codigo;
    document.getElementById('producto-nombre').value = productoEditar.nombre;
    document.getElementById('producto-descripcion').value = productoEditar.descripcion;
    document.getElementById('producto-categoria').value = productoEditar.id_categoria;
    document.getElementById('producto-precio').value = productoEditar.precio_venta;
    document.getElementById('producto-stock').value = productoEditar.stock_actual;
    document.getElementById('producto-stock-min').value = productoEditar.stock_minimo;
    document.getElementById('producto-imagen').value = productoEditar.url_imagen || '';
    if (productoEditar.url_imagen) { preview.src = productoEditar.url_imagen; preview.style.display = 'inline-block'; } else preview.style.display = 'none';
  } else {
    document.getElementById('form-producto').reset();
    document.getElementById('producto-imagen').value = '';
    preview.style.display = 'none';
  }
  document.getElementById('modal-producto').classList.remove('oculto');
}

function previsualizarImagenProducto(input) {
  const preview = document.getElementById('producto-imagen-preview');
  if (input.files && input.files[0]) {
    preview.src = URL.createObjectURL(input.files[0]);
    preview.style.display = 'inline-block';
  }
}

async function subirImagenCloudinary(archivo) {
  const formData = new FormData();
  formData.append('imagen', archivo);
  const res = await fetch(URL_BACKEND + '/api/upload-imagen', { method: 'POST', body: formData });
  const data = await res.json();
  if (!res.ok || !data.exito) throw new Error(data.mensaje || 'Error al subir la imagen');
  return data.url;
}

async function guardarProducto() {
  const nombre = document.getElementById('producto-nombre').value.trim();
  const descripcion = document.getElementById('producto-descripcion').value.trim();
  const id_categoria = parseInt(document.getElementById('producto-categoria').value);
  const precioStr = document.getElementById('producto-precio').value.trim();
  const stockStr = document.getElementById('producto-stock').value.trim();
  const stockMinStr = document.getElementById('producto-stock-min').value.trim();
  const archivoImagen = document.getElementById('producto-imagen-file').files[0];
  let url_imagen = document.getElementById('producto-imagen').value.trim();

  const soloLetras = /^[A-Za-zÀ-ÿ\s]+$/;
  if (!nombre || !soloLetras.test(nombre)) { alert('El nombre es obligatorio y solo debe contener letras.'); return; }
  if (nombre.length > 100) { alert('El nombre no debe superar los 100 caracteres.'); return; }
  if (descripcion && !soloLetras.test(descripcion)) { alert('La descripción solo debe contener letras.'); return; }
  if (descripcion.length > 255) { alert('La descripción no debe superar los 255 caracteres.'); return; }
  if (!id_categoria) { alert('Debes seleccionar una categoría.'); return; }
  if (!/^\d+(\.\d{1,2})?$/.test(precioStr) || parseFloat(precioStr) <= 0) { alert('El precio de venta debe tener un formato decimal válido (ej. 00.00) y ser mayor a 0.'); return; }
  if (!/^\d+$/.test(stockStr)) { alert('El stock actual debe ser un número entero.'); return; }
  if (!/^\d+$/.test(stockMinStr)) { alert('El stock mínimo debe ser un número entero.'); return; }
  const precio_venta = parseFloat(precioStr);
  const stock_actual = parseInt(stockStr, 10);
  const stock_minimo = parseInt(stockMinStr, 10);
  if (stock_minimo > stock_actual) { alert('El stock mínimo debe ser menor o igual que el stock actual.'); return; }

  if (archivoImagen) {
    try {
      url_imagen = await subirImagenCloudinary(archivoImagen);
    } catch (e) {
      alert('No se pudo subir la imagen: ' + e.message);
      return;
    }
  }

  const payload = { nombre, descripcion, id_categoria, precio_venta, stock_actual, stock_minimo, url_imagen };
  const method = productoEditar ? 'PUT' : 'POST';
  const url = URL_BACKEND + '/api/productos' + (productoEditar ? '/' + productoEditar.id_producto : '');

  await fetch(url, { method, headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
  cerrarModal('modal-producto');
  cargarProductos();
  cargarResumen();
}

function actualizarLongitudDocumento() {
  const tipo = document.getElementById('cliente-tipo-doc').value;
  const input = document.getElementById('cliente-num-doc');
  input.maxLength = tipo === 'RUC' ? 11 : 8;
  input.value = input.value.slice(0, input.maxLength);
}

function abrirModalCliente(id) {
  clienteEditar = id ? clientes.find(c => c.id_cliente === id) : null;
  document.getElementById('titulo-modal-cliente').textContent = clienteEditar ? 'Editar Cliente' : 'Nuevo Cliente';
  if (clienteEditar) {
    document.getElementById('cliente-id').value = clienteEditar.id_cliente;
    document.getElementById('cliente-tipo-doc').value = clienteEditar.tipo_documento;
    document.getElementById('cliente-num-doc').value = clienteEditar.num_documento;
    document.getElementById('cliente-nombres').value = clienteEditar.nombres;
    document.getElementById('cliente-ap-paterno').value = clienteEditar.apellido_paterno;
    document.getElementById('cliente-ap-materno').value = clienteEditar.apellido_materno;
    document.getElementById('cliente-telefono').value = clienteEditar.telefono;
    document.getElementById('cliente-correo').value = clienteEditar.correo;
  } else document.getElementById('form-cliente').reset();
  actualizarLongitudDocumento();
  document.getElementById('modal-cliente').classList.remove('oculto');
}

async function guardarCliente() {
  const tipoDoc = document.getElementById('cliente-tipo-doc').value;
  const numDoc = document.getElementById('cliente-num-doc').value.trim();
  const nombres = document.getElementById('cliente-nombres').value.trim();
  const apP = document.getElementById('cliente-ap-paterno').value.trim();
  const apM = document.getElementById('cliente-ap-materno').value.trim();
  const tel = document.getElementById('cliente-telefono').value.trim();
  const correo = document.getElementById('cliente-correo').value.trim();
  const soloLetras = /^[A-Za-zÀ-ÿ\s]+$/;
  if (!numDoc || !nombres || !apP || !apM) { alert('Completa los campos obligatorios.'); return; }
  if (tipoDoc === 'DNI' && !/^\d{8}$/.test(numDoc)) { alert('El DNI debe tener exactamente 8 números.'); return; }
  if (tipoDoc === 'RUC' && !/^\d{11}$/.test(numDoc)) { alert('El RUC debe tener exactamente 11 números.'); return; }
  if (!soloLetras.test(nombres)) { alert('Los nombres solo deben contener letras.'); return; }
  if (!soloLetras.test(apP)) { alert('El apellido paterno solo debe contener letras.'); return; }
  if (!soloLetras.test(apM)) { alert('El apellido materno solo debe contener letras.'); return; }
  if (tel && !/^9\d{8}$/.test(tel)) { alert('El teléfono debe tener 9 dígitos y comenzar con 9.'); return; }
  if (correo && !/^[^\s@]+@[^\s@]+\.com$/i.test(correo)) { alert('El correo debe ser válido y terminar en .com'); return; }

  const payload = { tipoDoc, numDoc, nombres, apellidoPaterno: apP, apellidoMaterno: apM, telefono: tel, correo, idCreador: localStorage.getItem('idUsuario') };
  // Aiven API usa camelCase en /api/registrar-cliente para insertar, pero el PUT espera snake_case (tipo_documento, numero_documento).
  // Vamos a alinear ambos. Si es crear, usamos /api/registrar-cliente. Si es editar, usamos el nuevo /api/clientes/:id con snake_case
  
  if (clienteEditar) {
    const payloadUpdate = { tipo_documento: tipoDoc, numero_documento: numDoc, nombres, apellido_paterno: apP, apellido_materno: apM, telefono: tel, correo };
    await fetch(URL_BACKEND + '/api/clientes/' + clienteEditar.id_cliente, { method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payloadUpdate) });
  } else {
    await fetch(URL_BACKEND + '/api/registrar-cliente', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload) });
  }
  
  cerrarModal('modal-cliente');
  cargarClientes();
  cargarResumen();
}

function confirmarEliminar(tipo, id, nombre) {
  document.getElementById('confirmar-titulo').textContent = 'Confirmar eliminacion';
  document.getElementById('confirmar-mensaje').textContent = 'Eliminar "' + nombre + '"? (Solo Soft Delete).';
  document.getElementById('btn-confirmar-accion').onclick = () => ejecutarEliminar(tipo, id);
  document.getElementById('modal-confirmar').classList.remove('oculto');
}

async function ejecutarEliminar(tipo, id) {
  const url = URL_BACKEND + (tipo === 'producto' ? '/api/productos/' : '/api/clientes/') + id;
  await fetch(url, { method: 'DELETE' });
  cerrarModal('modal-confirmar');
  if (tipo === 'producto') cargarProductos(); else cargarClientes();
  cargarResumen();
}

function confirmarAnular(idPedido, idComprobante, correlativo) {
  document.getElementById('confirmar-titulo').textContent = 'Anular comprobante';
  document.getElementById('confirmar-mensaje').textContent = 'Anular comprobante ' + correlativo + ' (Pedido #' + idPedido + ')?';
  document.getElementById('btn-confirmar-accion').onclick = () => ejecutarAnular(idPedido, idComprobante);
  document.getElementById('modal-confirmar').classList.remove('oculto');
}

async function ejecutarAnular(idPedido, idComprobante) {
  await fetch(URL_BACKEND + '/api/admin/comprobantes/' + idComprobante + '/anular', { method: 'PUT' });
  cerrarModal('modal-confirmar');
  cargarComprobantes();
  cargarPedidos();
  cargarResumen();
}

async function verDetallePedido(idPedido, cliente, fecha, estado, total) {
  // If called from Comprobantes without extra parameters, fetch them from pedidos array
  if (!cliente) {
      const p = pedidos.find(x => x.id_pedido === idPedido);
      if(p) {
          cliente = (p.nombres + ' ' + p.apellido_paterno).trim();
          fecha = p.fecha_pedido ? new Date(p.fecha_pedido).toLocaleDateString('es-PE') : '-';
          estado = p.estado;
          total = p.total;
      }
  }
  const res = await fetch(URL_BACKEND + '/api/admin/pedidos/' + idPedido + '/detalles');
  const detalles = await res.json();
  
  document.getElementById('titulo-modal-detalle').textContent = 'Detalle Pedido #' + idPedido;
  document.getElementById('info-pedido-detalle').innerHTML = '<strong>Cliente:</strong> ' + cliente + ' &nbsp;|&nbsp; <strong>Fecha:</strong> ' + fecha + ' &nbsp;|&nbsp; <strong>Estado:</strong> ' + estado;
  document.getElementById('body-detalle-pedido').innerHTML = detalles.map(d => '<tr><td>'+d.nombre+'</td><td>'+d.cantidad+'</td><td>S/ '+parseFloat(d.precio_unitario).toFixed(2)+'</td><td><b>S/ '+parseFloat(d.subtotal).toFixed(2)+'</b></td></tr>').join('');
  document.getElementById('total-detalle').textContent = 'S/ ' + parseFloat(total).toFixed(2);
  document.getElementById('modal-detalle').classList.remove('oculto');
}

// Inicialización de la vista
async function inicializarDashboard() {
  await cargarCategorias();
  cargarResumen();
  cargarProductos();
  cargarClientes();
  cargarPedidos();
  cargarComprobantes();
}

inicializarDashboard();

