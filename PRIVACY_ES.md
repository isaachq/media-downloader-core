# Política de Privacidad y Seguridad de Datos

**Última actualización:** 30 de octubre de 2026  
**Proyecto:** Media Downloader Core y Media Downloader Core para Android  
**Responsable:** isaachq (`isaac.hernandez.qz@gmail.com`)  
**Repositorio:** [https://github.com/isaachq/media-downloader-core](https://github.com/isaachq/media-downloader-core)  
**Idioma:** Español | *Read in [English](PRIVACY.md)*

---

## 1. Resumen y Compromiso con la Privacidad del Usuario

Media Downloader Core (incluyendo su interfaz de línea de comandos CLI, aplicación de escritorio y aplicación móvil para Android) está diseñado bajo una **estricta arquitectura de privacidad desde el diseño**:

* **Cero Recolección de Datos Personales:** No recopilamos, almacenamos, transmitimos ni monetizamos ningún tipo de información de identificación personal (PII).
* **Sin Anuncios ni Rastreo Publicitario:** Sin bibliotecas de publicidad, sin ID de publicidad y sin huella digital (*fingerprinting*). La biblioteca, la CLI y la app de escritorio no envían ninguna telemetría.
* **Estadísticas de Uso Anónimas y Opcionales (app de Android):** la app de Android puede enviar estadísticas de uso anónimas (Firebase Analytics) para saber qué funciones se usan y qué falla. Puedes desactivarlas en cualquier momento en Ajustes > Privacidad. Ver sección 3.
* **Cero Venta o Compartición de Datos:** Nunca vendemos, alquilamos, comercializamos ni compartimos datos del usuario con terceros ni redes de anunciantes.

---

## 2. Declaración de Seguridad de los Datos (Cumplimiento Google Play)

| Categoría | Especificación | Detalles |
|---|---|---|
| **Recolección de datos** | **Anónima y opcional (app de Android)** | Interacciones con la app, diagnóstico (códigos de error) y un ID de instancia aleatorio, solo mientras "Compartir estadísticas de uso anónimas" está activado (sección 3). No se recopilan datos personales, información de contacto, datos financieros, de salud ni ubicación. |
| **Compartición de datos** | **Ninguna** | Las estadísticas de uso las procesa Google (Firebase) como proveedor de servicio, solo para el responsable. Ningún dato se vende ni se envía a redes publicitarias. |
| **Datos de sesión/cuenta** | **Exclusivamente local** | Cuando se usa el inicio de sesión opcional (p. ej. TikTok, Instagram, Facebook), las cookies se guardan **únicamente en el almacenamiento privado y aislado de la app en el dispositivo**. |
| **Peticiones de red** | **Directas y solicitadas por el usuario** | Las consultas de metadatos y descargas se conectan directamente entre el dispositivo y el servidor público de origen. No se emplean intermediarios, proxies de rastreo ni servidores de terceros. |
| **Prácticas de seguridad** | **Aislamiento seguro del SO** | Los datos están protegidos por el sandboxing del sistema operativo y permisos a nivel de archivo. |
| **Eliminación de datos** | **Control total del usuario** | El usuario puede borrar cookies, historial, lotes o archivos multimedia en cualquier momento desde la app. Al desinstalar la app se eliminan todos los datos privados de inmediato. |

---

## 3. Estadísticas de Uso Anónimas (solo la app de Android)

Desde la versión 0.2.0-beta.45 la **app de Android** puede enviar estadísticas de uso anónimas mediante Google Firebase Analytics. La biblioteca, la CLI y la app de escritorio no envían nada.

**Por qué:** la app la hace una sola persona, y su teléfono no es el mundo real. Saber qué funciones se usan y qué sitios y formatos fallan, y con qué error, es como la app mejora. No hay monetización detrás.

**Tu elección:** vienen activadas y puedes desactivarlas en cualquier momento en **Ajustes > Privacidad > Compartir estadísticas de uso anónimas**. Al apagarlas se detienen de inmediato y siguen apagadas tras reiniciar.

**Qué se envía** (solo mientras el ajuste está activado):
* Eventos: una descarga empezó, terminó, falló, se canceló u omitió; se programó un lote o una lista mixta, y al terminar un lote su reporte en números (cuántos se descargaron, fallaron, se cancelaron o no estaban disponibles, la causa más común, cuánto tardó); se leyó un enlace; empezó o terminó una grabación en vivo; se inició o cerró sesión en un sitio; se abrió una pantalla; se usó una función como compartir o reintentar.
* Con cada evento, solo códigos cortos y números: el sitio (por ejemplo `tiktok`), el formato (por ejemplo `mp4_1080`), el código de error y el paso del motor (por ejemplo `needs-sign-in`, `download`), los intentos, el tamaño en MB y la duración.
* Tipo de dispositivo (teléfono o tablet) y ajustes en uso: idioma, tema, formato por defecto, segundo plano, solo Wi-Fi, galería, modo de reintentos, verificación de integridad.
* Lo que Firebase agrega por sí mismo: un ID de instancia aleatorio (se reinicia al borrar los datos de la app o reinstalarla), versión de la app, versión de Android, modelo del dispositivo, país, y cuánto tiempo se usa la app y cada pantalla.

**Qué nunca se envía:** enlaces (URL), títulos, nombres de usuario, canal o cuenta, nombres de archivos o carpetas, mensajes de error, cookies o sesiones, el ID de publicidad ni el Android ID. La app revisa cada valor antes de enviarlo y descarta todo lo que no sea un código corto o un número, así que un enlace o un título no puede enviarse por error.

**Encargado y retención:** Google LLC (Firebase Analytics) procesa los datos para el responsable según los [términos de procesamiento de datos de Firebase](https://firebase.google.com/terms/data-processing-terms). No se venden, no se comparten con otras empresas ni se usan para publicidad; la personalización de anuncios está desactivada. Los datos se conservan durante el periodo configurado en Firebase y luego se eliminan. Los datos no están vinculados a tu identidad: para detenerlos, apaga el ajuste; para desvincular tus datos anteriores de tu dispositivo, borra los datos de la app o reinstálala (se crea un ID aleatorio nuevo).

---

## 4. Almacenamiento y Permisos en Android

* **Almacenamiento Local de la App:** Los archivos se guardan en el almacenamiento exclusivo de la app o en la carpeta elegida por el usuario mediante el Selector de Archivos del Sistema (Storage Access Framework - SAF).
* **Servicio en Primer Plano (`dataSync`):** Se utiliza estrictamente durante descargas activas solicitadas por el usuario para mantener el proceso en segundo plano y mostrar una notificación de progreso en tiempo real (cumpliendo con Android 14+).
* **Permiso de Notificaciones (`POST_NOTIFICATIONS`):** Se utiliza exclusivamente para mostrar la barra de progreso de descarga y el estado final. Nunca se envían promociones ni publicidad.

---

## 5. Propiedad Intelectual y Términos de Servicio

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

## 6. Cambios en esta Política

Cualquier cambio futuro será publicado directamente en este repositorio con la fecha de actualización correspondiente.

## 7. Contacto

Para consultas o comentarios sobre esta política de privacidad:
* **GitHub Issues:** [https://github.com/isaachq/media-downloader-core/issues](https://github.com/isaachq/media-downloader-core/issues)
* **Correo electrónico:** isaac.hernandez.qz@gmail.com
