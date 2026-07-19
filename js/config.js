// js/config.js
// =============================================
// CONFIGURACIÓN GLOBAL — Book Center
// =============================================
const URL_BACKEND = 'https://bookcenter-backend.onrender.com';

// =============================================
// GESTIÓN DE SESIÓN
// =============================================

/**
 * Devuelve el objeto del usuario logueado (desde localStorage).
 * Estructura: { id_usuario, nombre_completo, id_rol, nombre_rol, id_sede, nombre_sede, codigo_sede }
 * @returns {Object|null}
 */
function getUsuario() {
    try {
        const raw = localStorage.getItem('usuarioInfo');
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

/**
 * Devuelve el token JWT almacenado o null si no existe.
 * @returns {string|null}
 */
function getToken() {
    return localStorage.getItem('token') || null;
}

/**
 * Cierra la sesión limpiando localStorage y sessionStorage,
 * y redirige al login.
 */
function cerrarSesion() {
    localStorage.clear();
    sessionStorage.clear();
    window.location.href = '/';
}

/**
 * Wrapper de fetch que adjunta automáticamente el header Authorization.
 * Si el servidor responde 401 (token inválido/expirado), cierra la sesión.
 *
 * @param {string} ruta - Ruta relativa al backend (ej: '/api/productos')
 * @param {Object} opciones - Mismo objeto de opciones que fetch nativo
 * @returns {Promise<Response>}
 */
async function apiFetch(ruta, opciones = {}) {
    const token = getToken();

    const headers = {
        'Content-Type': 'application/json',
        ...(opciones.headers || {}),
    };

    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }

    const respuesta = await fetch(`${URL_BACKEND}${ruta}`, {
        ...opciones,
        headers,
    });

    if (respuesta.status === 401) {
        cerrarSesion();
        return;
    }

    return respuesta;
}