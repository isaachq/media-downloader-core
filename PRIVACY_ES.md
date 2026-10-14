# Política de Privacidad y Seguridad de Datos

**Última actualización:** 14 de octubre de 2026  
**Proyecto:** Media Downloader Core y Media Downloader Core para Android  
**Responsable:** isaachq (`isaac.hernandez.qz@gmail.com`)  
**Repositorio:** [https://github.com/isaachq/media-downloader-core](https://github.com/isaachq/media-downloader-core)  
**Idioma:** Español | *Read in [English](PRIVACY.md)*

---

## 1. Resumen y Compromiso con la Privacidad del Usuario

Media Downloader Core (incluyendo su interfaz de línea de comandos CLI, aplicación de escritorio y aplicación móvil para Android) está diseñado bajo una **estricta arquitectura de privacidad desde el diseño**:

* **Cero Recolección de Datos Personales:** No recopilamos, almacenamos, transmitimos ni monetizamos ningún tipo de información de identificación personal (PII).
* **Cero Rastreo / Cero Telemetría:** La aplicación no contiene SDKs de analíticas, bibliotecas de publicidad, rastreadores de fallos ni técnicas de huella digital (*fingerprinting*).
* **Cero Venta o Compartición de Datos:** Nunca vendemos, alquilamos, comercializamos ni compartimos datos del usuario con terceros ni redes de anunciantes.

---

## 2. Declaración de Seguridad de los Datos (Cumplimiento Google Play)

| Categoría | Especificación | Detalles |
|---|---|---|
| **Recolección de datos** | **Ninguna** | No se recopilan datos personales, información de contacto, datos financieros, de salud ni ubicación. |
| **Compartición de datos** | **Ninguna** | Ningún dato es transferido a servidores externos, bases de datos de terceros ni redes publicitarias. |
| **Datos de sesión/cuenta** | **Exclusivamente local** | Cuando se usa el inicio de sesión opcional (p. ej. TikTok, Instagram, Facebook), las cookies se guardan **únicamente en el almacenamiento privado y aislado de la app en el dispositivo**. |
| **Peticiones de red** | **Directas y solicitadas por el usuario** | Las consultas de metadatos y descargas se conectan directamente entre el dispositivo y el servidor público de origen. No se emplean intermediarios, proxies de rastreo ni servidores de terceros. |
| **Prácticas de seguridad** | **Aislamiento seguro del SO** | Los datos están protegidos por el sandboxing del sistema operativo y permisos a nivel de archivo. |
| **Eliminación de datos** | **Control total del usuario** | El usuario puede borrar cookies, historial, lotes o archivos multimedia en cualquier momento desde la app. Al desinstalar la app se eliminan todos los datos privados de inmediato. |

---

## 3. Almacenamiento y Permisos en Android

* **Almacenamiento Local de la App:** Los archivos se guardan en el almacenamiento exclusivo de la app o en la carpeta elegida por el usuario mediante el Selector de Archivos del Sistema (Storage Access Framework - SAF).
* **Servicio en Primer Plano (`dataSync`):** Se utiliza estrictamente durante descargas activas solicitadas por el usuario para mantener el proceso en segundo plano y mostrar una notificación de progreso en tiempo real (cumpliendo con Android 14+).
* **Permiso de Notificaciones (`POST_NOTIFICATIONS`):** Se utiliza exclusivamente para mostrar la barra de progreso de descarga y el estado final. Nunca se envían promociones ni publicidad.

---

## 4. Propiedad Intelectual y Términos de Servicio

### A. Descargo de No Afiliación
Media Downloader Core es un proyecto de software libre e independiente. **No** está patrocinado, respaldado, afiliado, asociado ni autorizado por:
* **TikTok** ni ByteDance Ltd.
* **Instagram**, **Facebook**, ni Meta Platforms, Inc.
* Ningún otro proveedor o plataforma de terceros.

Todos los nombres comerciales, marcas registradas, logotipos y marcas pertenecen a sus respectivos propietarios. Su uso en esta aplicación y documentación tiene fines estrictamente identificativos e interoperables bajo uso legítimo nominativo (*nominative fair use*).

### B. Derechos de Autor y Uso Responsable
* Media Downloader Core está concebido como una herramienta de respaldo personal, visualización sin conexión y archivo educativo de contenido multimedia que el usuario posee o para el cual cuenta con autorización explícita del titular de los derechos de autor.
* La aplicación no debe utilizarse para infringir leyes de copyright, eludir sistemas de protección digital (DRM) ni vulnerar la propiedad intelectual de los creadores de contenido.
* El usuario es el único responsable del cumplimiento de las leyes de derechos de autor locales y de los Términos de Servicio de las plataformas de donde descarga contenido público.

---

## 5. Cambios en esta Política

Cualquier cambio futuro será publicado directamente en este repositorio con la fecha de actualización correspondiente.

## 6. Contacto

Para consultas o comentarios sobre esta política de privacidad:
* **GitHub Issues:** [https://github.com/isaachq/media-downloader-core/issues](https://github.com/isaachq/media-downloader-core/issues)
* **Correo electrónico:** isaac.hernandez.qz@gmail.com
