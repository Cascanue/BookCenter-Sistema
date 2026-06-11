const formCliente = document.getElementById('formCliente');
const mensaje = document.getElementById('mensaje');

formCliente.addEventListener('submit', async (evento) => {
    evento.preventDefault(); // Evita que la página recargue al darle al botón

    // Recolectamos lo que escribió el vendedor
    const datosCliente = {
        documento: document.getElementById('documento').value,
        nombre: document.getElementById('nombre').value,
        telefono: document.getElementById('telefono').value,
        correo: document.getElementById('correo').value
    };

    mensaje.textContent = "Procesando registro...";
    mensaje.style.color = "orange";

    try {

        // Viajamos al servidor enviando los datos a la ruta exacta
const respuesta = await fetch('https://bookcenter-backend.onrender.com/api/registrar-cliente', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(datosCliente) // Convertimos los datos a texto para el viaje
        });

        const resultado = await respuesta.json();

        if (respuesta.ok) {
            mensaje.textContent = "✅ " + resultado.mensaje;
            mensaje.style.color = "green";
            formCliente.reset(); // Limpiamos las casillas
        } else {
            mensaje.textContent = "❌ " + resultado.mensaje;
            mensaje.style.color = "red";
        }
    } catch (error) {
        mensaje.textContent = "❌ Error de conexión con el servidor.";
        mensaje.style.color = "red";
    }
});