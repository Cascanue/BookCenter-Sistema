
//https://bookcenter-backend.onrender.com/api/registrar-cliente


const formProducto = document.getElementById('formProducto');
const mensaje = document.getElementById('mensaje');
const listaProductos = document.getElementById('listaProductos');

// IP DE CONEXIÓN: Cambiar por tu link de Render cuando lo subas a internet
const URL_BACKEND = 'http://localhost:3000'; 

// Función para cargar y pintar los productos que están guardados en Aiven
async function cargarCatalogo() {
    try {
        const res = await fetch(`${URL_BACKEND}/api/productos`);
        const productos = res.ok ? await res.json() : [];
        listaProductos.innerHTML = '';
        
        productos.forEach(prod => {
            listaProductos.innerHTML += `
                <div style="border: 1px solid #ccc; padding: 10px; display: flex; gap: 15px; align-items: center;">
                    <img src="${prod.url_imagen}" alt="${prod.nombre}" style="width: 80px; height: 80px; object-fit: cover;">
                    <div>
                        <h3>${prod.nombre}</h3>
                        <p>Precio: S/. ${prod.precio} | Stock: ${prod.stock} unidades</p>
                    </div>
                </div>
            `;
        });
    } catch (e) {
        console.error("Error cargando catálogo", e);
    }
}

// Escuchar el botón de Guardar
formProducto.addEventListener('submit', async (evento) => {
    evento.preventDefault();
    mensaje.textContent = "Subiendo imagen a Cloudinary y registrando...";
    mensaje.style.color = "orange";

    // Creamos el paquete especial para transportar archivos físicos
    const paqueteDatos = new FormData();
    paqueteDatos.append('nombre', document.getElementById('nombre').value);
    paqueteDatos.append('precio', document.getElementById('precio').value);
    paqueteDatos.append('stock', document.getElementById('stock').value);
    paqueteDatos.append('imagenProducto', document.getElementById('imagenProducto').files[0]);

    try {
        const respuesta = await fetch(`${URL_BACKEND}/api/registrar-producto`, {
            method: 'POST',
            body: paqueteDatos // Enviamos el archivo físico suelto sin JSON.stringify
        });

        const resultado = await respuesta.json();

        if (respuesta.ok) {
            mensaje.textContent = "✅ " + resultado.mensaje;
            mensaje.style.color = "green";
            formProducto.reset();
            cargarCatalogo(); // Refrescar la lista automáticamente
        } else {
            mensaje.textContent = "❌ " + resultado.mensaje;
            mensaje.style.color = "red";
        }
    } catch (error) {
        mensaje.textContent = "❌ Error de conexión con el servidor.";
        mensaje.style.color = "red";
    }
});

// Cargar los productos apenas se abra la página
cargarCatalogo();