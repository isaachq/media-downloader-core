# Plan de desarrollo y regresión de formatos

> Repositorio: `media-downloader-core`
>
> Estado inicial analizado: `1.12.0`, 313 pruebas aprobadas, 88 suites y
> `npm run check` en verde el 2026-10-14.
>
> Objetivo: garantizar que cada perfil solicitado produzca realmente el
> contenedor, los códecs, la resolución y el archivo prometidos antes de
> publicar una nueva versión del core.

## 1. Motivo y defecto de referencia

El caso que originó este plan fue una descarga TikTok solicitada como
`video:mkv:360`. La descarga y el paso de conversión terminaron, pero la
validación encontró el contenedor original MP4:

```text
Unexpected container: mov,mp4,m4a,3gp,3g2,mj2
```

La causa primaria está en `src/core/convert.ts`: para MKV se devuelve el
archivo de entrada sin comprobar que sea Matroska. Las fuentes nativas suelen
entregar MP4 progresivo, por lo que cambiar la extensión no crea un MKV.

Problemas relacionados que este plan debe resolver:

- MKV no se remultiplexa cuando la entrada es MP4 o WebM.
- TikTok/Instagram/Facebook y Player Page no declaran correctamente el coste
  de producir MKV.
- `requiresConversion` agrupa copia, remux, extracción y transcodificación.
- Un error determinista de contenedor/códec se considera reintentable y puede
  volver a descargar exactamente el mismo archivo varias veces.
- Los escenarios generales usan principalmente MP4 y dobles de ffprobe que no
  demuestran la conformidad real de otros formatos.
- Las calidades se tratan como caps, pero una ruta puede elegir una rendition
  superior si no encuentra otra debajo del cap.
- Slideshows y bundles necesitan un contrato explícito de formato.

## 2. Contrato que debe quedar congelado

### 2.1 Matriz pública

La regresión mínima contiene **26 perfiles**:

| Familia | Perfiles | Casos |
| --- | --- | ---: |
| MP4 | Best, 2160, 1440, 1080, 720, 480, 360 | 7 |
| WebM | Best, 2160, 1440, 1080, 720, 480, 360 | 7 |
| MKV | Best, 2160, 1440, 1080, 720, 480, 360 | 7 |
| Audio | M4A, MP3, Opus, FLAC, WAV | 5 |
| **Total** |  | **26** |

`Best` se representa con `maxHeight` ausente. No debe omitirse de la matriz.

### 2.2 Salida prometida

| Perfil | Contenedor aceptado por ffprobe | Video | Audio |
| --- | --- | --- | --- |
| MP4 | `mov,mp4,m4a,3gp,3g2,mj2` | H.264/AVC | AAC cuando la fuente tiene audio |
| WebM | `matroska,webm` | VP8, VP9 o AV1 | Opus o Vorbis cuando existe audio |
| MKV | `matroska,webm`, identificado como Matroska | Mejor stream conservable | Mejor stream conservable |
| M4A | MP4/M4A | Ninguno | AAC |
| MP3 | MP3 | Ninguno | MP3 |
| Opus | Ogg/Opus | Ninguno | Opus |
| FLAC | FLAC | Ninguno | FLAC |
| WAV | WAV | Ninguno | PCM |

La extensión debe coincidir con el perfil. Para Opus se debe decidir y
documentar una extensión canónica (`.opus` recomendada) aunque ffprobe reporte
Ogg como contenedor.

### 2.3 Semántica de calidad recomendada

- `Best`: mayor resolución disponible sin ampliar artificialmente.
- Una calidad numérica es un límite máximo estricto.
- La salida debe cumplir `height <= maxHeight`.
- Si no hay rendition debajo del límite, descargar la menor disponible y
  reducirla localmente.
- Si la fuente es menor al límite, no ampliarla.
- Conservar proporción, orientación y SAR/DAR.
- Producir dimensiones válidas para el encoder, normalmente pares.

Esta decisión debe documentarse en README y quedar cubierta por pruebas.

## 3. Diseño de la corrección

### Fase C0 — Caracterización antes de modificar

- [ ] Añadir una prueba roja que reproduzca MP4 de entrada → MKV solicitado.
- [ ] Confirmar que la salida actual mantiene contenedor MP4.
- [ ] Añadir una prueba roja de MKV en TikTok native choices.
- [ ] Añadir una prueba roja de MKV en Player Page choices.
- [ ] Caracterizar qué ocurre al pedir 360 con una única fuente 720.
- [ ] Caracterizar MP4/WebM/MKV en slideshow.
- [ ] Caracterizar video/audio solicitado sobre un carousel/bundle.
- [ ] Registrar número de intentos ante `unexpected-container`.

No relajar el validador para hacer pasar estos casos. El validador está
detectando correctamente la salida incorrecta.

### Fase C1 — Plan de procesamiento explícito

Introducir internamente un tipo equivalente a:

```ts
type ProcessingKind = 'none' | 'remux' | 'transcode' | 'extract'
```

Tareas:

- [ ] Calcular el tipo desde perfil, rendition y streams reales.
- [ ] Mantener `requiresConversion` como valor derivado si forma parte de la
  API pública.
- [ ] Usar el tipo para estimación de disco, tier del job y logging.
- [ ] Diferenciar en trazas `remuxing`, `transcoding` y `extracting` aunque la
  API pública conserve el paso genérico `convert`.
- [ ] Revisar `src/core/cost.ts`, `src/scheduler.ts`, `src/downloader.ts`,
  `src/sources/renditions.ts`, `src/sources/player-page/source.ts` y choices
  de audio.

### Fase C2 — MKV correcto

- [ ] Probar el contenedor real antes de devolver la entrada.
- [ ] Si la entrada ya es Matroska y no requiere escala, conservarla.
- [ ] Para MP4/WebM → MKV ejecutar remux con mapeo explícito de streams y
  `-c copy`.
- [ ] Si además se necesita reducir resolución, transcodificar video y decidir
  la política de audio por compatibilidad.
- [ ] Preservar metadata útil, capítulos y subtítulos compatibles.
- [ ] No incorporar thumbnails como pista de video reproducible.
- [ ] Escribir a temporal y reemplazar sólo después de ffmpeg + validación.
- [ ] Limpiar entrada y temporales en éxito, error y cancelación.

### Fase C3 — Resoluciones

- [ ] Hacer cumplir el cap en fuentes nativas, Player Page y yt-dlp.
- [ ] No escalar hacia arriba.
- [ ] Probar landscape, portrait, rotación metadata y dimensiones impares.
- [ ] Confirmar que Best no queda limitado accidentalmente a 1080.
- [ ] Revisar `genericChoices`: hoy MP4 no anuncia todas las alturas que la
  aplicación móvil permite seleccionar.

### Fase C4 — Audio

- [ ] M4A: copiar AAC cuando sea seguro; convertir otros códecs a AAC.
- [ ] MP3: codificar a MP3 y eliminar toda pista de video.
- [ ] Opus: copiar Opus compatible o codificar a Opus.
- [ ] FLAC: codificar lossless desde la fuente decodificada.
- [ ] WAV: producir PCM con parámetros documentados.
- [ ] Conservar tags soportados.
- [ ] Tratar cover art como imagen adjunta, no como video principal.
- [ ] Definir respuesta para fuentes sin audio.
- [ ] Corregir estimates/tier: extraer audio siempre implica procesamiento,
  aunque no siempre implique recodificar.

### Fase C5 — Taxonomía de errores y reintentos

Clasificar por causa y no sólo por etapa:

| Causa | Política |
| --- | --- |
| Red, timeout, URL expirada | Reintentar con backoff/extracción fresca |
| HTTP 403/429 | Respetar política de fuente/sesión; reintento limitado |
| Fuente truncada/corrupta | Confirmar máximo dos veces y marcar damaged |
| Contenedor/códec incorrecto después de convertir | Error interno inmediato |
| Argumentos o encoder FFmpeg inválidos | No redescargar |
| Espacio insuficiente | No reintentar automáticamente |
| Cancelación | Terminal cancelado, sin marcar damaged |

- [ ] `unexpected-container`, `unexpected-video-codec` y
  `unexpected-audio-codec` deben distinguir defecto de transformación y daño
  de origen usando el contexto de la etapa.
- [ ] Una salida determinísticamente incorrecta debe consumir un intento.
- [ ] Conservar la detección de archivos genuinamente dañados en origen.

### Fase C6 — Slideshows y bundles

- [ ] Slideshow MP4/WebM/MKV con soundtrack.
- [ ] Slideshow MP4/WebM/MKV sin soundtrack.
- [ ] Solicitud de audio sobre slideshow silencioso: unavailable claro.
- [ ] Definir si el perfil aplica a cada video de un carousel.
- [ ] Recomendación: transformar cada item audiovisual al perfil pedido y
  validar cada archivo del bundle.
- [ ] Si se elige conservar originales, anunciar `original bundle` y no
  afirmar que el resultado corresponde a WebM/MKV.

## 4. Laboratorio determinista de medios

Crear helpers que generen fixtures cortos con FFmpeg real. No almacenar
binarios grandes en Git.

Fixtures requeridos:

- [ ] MP4 H.264/AAC: 2160, 1440, 1080, 720, 480 y 360.
- [ ] MP4 H.265/AAC.
- [ ] WebM VP9/Opus.
- [ ] WebM AV1/Opus cuando el FFmpeg del runner lo soporte.
- [ ] Video sin audio.
- [ ] Audio AAC y audio Opus.
- [ ] Video vertical 9:16.
- [ ] Rotación mediante metadata.
- [ ] VFR.
- [ ] H.265 10-bit.
- [ ] Cover art embebido.
- [ ] Archivo truncado.
- [ ] Corrupción en la mitad del stream.
- [ ] Duración que contradiga metadata de fuente.

Los clips de PR deben durar 2–5 segundos. Nightly puede utilizar clips de 30
segundos y una prueba larga separada.

## 5. Suite de conformidad

Crear una suite data-driven con IDs estables:

```text
CORE-MP4-BEST ... CORE-MP4-360
CORE-WEBM-BEST ... CORE-WEBM-360
CORE-MKV-BEST ... CORE-MKV-360
CORE-AUDIO-M4A
CORE-AUDIO-MP3
CORE-AUDIO-OPUS
CORE-AUDIO-FLAC
CORE-AUDIO-WAV
```

Cada caso debe comprobar con ffprobe/ffmpeg reales:

- [ ] Extensión.
- [ ] Contenedor interno.
- [ ] Códec de cada stream.
- [ ] Ausencia de video en perfiles de audio.
- [ ] Audio presente si la fixture lo tiene.
- [ ] Resolución dentro del límite.
- [ ] Duración dentro de tolerancia.
- [ ] Decodificación completa sin errores.
- [ ] Tamaño mayor que cero.
- [ ] SHA-256 calculado.
- [ ] Estado y pasos finales del job.
- [ ] Tipo de procesamiento esperado.
- [ ] Número de intentos.
- [ ] Entrada correcta en archive.
- [ ] Cero temporales restantes.

Ejecutar los cinco perfiles de audio al menos desde una fuente AAC y una
fuente Opus.

## 6. Cobertura por fuente y escenario

Conservar las pruebas rápidas con fakes para orquestación, pero añadir una
capa con archivos reales y servidor HTTP local.

| Familia | Cobertura requerida |
| --- | --- |
| yt-dlp | 26 perfiles; descarga/merge/postprocesado es una ruta propia |
| TikTok nativo | 26 perfiles sobre respuesta fake + medios reales |
| Instagram nativo | Parsers propios y matriz sobre pipeline Meta |
| Facebook nativo | Parsers propios y matriz sobre pipeline Meta |
| Player Page | 26 perfiles y expiración/refresco de URL |
| Slideshow | Tres videos y cinco audios cuando existe soundtrack |
| Carousel/bundle | Transformación/validación por item |
| Lista/perfil | Lote representativo por perfil y mezcla de fallos |

Conteo nightly de referencia: cinco fuentes principales por 26 perfiles =
**130 casos**, más slideshows, bundles y negativos.

## 7. Regresión de resiliencia

- [ ] Cancelar durante download, remux, transcode, extract y validate.
- [ ] Cerrar proceso y recuperar estado.
- [ ] Disco lleno en cada etapa que escribe.
- [ ] Archivo destino existente.
- [ ] Nombres Unicode, emoji y rutas largas.
- [ ] Falta de encoder.
- [ ] ffmpeg retorna 0 pero produce salida inválida.
- [ ] Validación `none`, `quick` y `full`.
- [ ] Validación `during` y `after-batch`.
- [ ] Lote con un item cancelado, uno dañado y uno correcto.
- [ ] Archivo válido con extensión falsa.
- [ ] Archivo con contenedor correcto y códec incorrecto.
- [ ] Fuente sin pista solicitada.
- [ ] Reintento preserva exactamente el perfil original.

## 8. Cadencia recomendada

### Pull request

- `npm run check`.
- 26 casos de conformidad con clips pequeños.
- Unitarias de planificación y argumentos FFmpeg.
- Regresión MKV y clasificación de reintentos.
- Un caso representativo por familia de fuente.

### Nightly

- Matriz local de 130 casos.
- Validación full.
- Cancelación/recuperación.
- Clips de 30 segundos.
- Reporte JUnit + manifiesto JSON de ffprobe por salida.

### Semanal/manual

- Fuentes públicas reales.
- Archivos largos y 2160p.
- Autenticación/cookies.
- Rate limits y URLs expiradas.

Los sitios reales son diagnóstico de compatibilidad, no el oráculo de
conformidad del formato.

## 9. Puerta de publicación

No publicar hasta cumplir todo:

- [ ] 26/26 perfiles base válidos.
- [ ] 130/130 casos locales nightly válidos.
- [ ] MP4 de entrada solicitado como MKV termina como Matroska.
- [ ] Todos los caps cumplen `height <= maxHeight`.
- [ ] Ningún error determinista redescarga el medio.
- [ ] Cero temporales tras éxito, error y cancelación.
- [ ] Todas las suites preexistentes continúan en verde.
- [ ] Paquete `.tgz` probado en proyecto limpio con import ESM y require CJS.
- [ ] Node 20, 22 y 24.
- [ ] README y changelog actualizados.
- [ ] Android puede consumir el tarball/versión sin adaptadores temporales.

Versión recomendada: `1.13.0` si cambia la semántica pública o se expone el
tipo de procesamiento; `1.12.1` sólo si el arreglo queda estrictamente interno.

## 10. Entregables

- [ ] Corrección de MKV.
- [ ] Contrato de resolución documentado.
- [ ] Planner de procesamiento explícito.
- [ ] Taxonomía de reintentos corregida.
- [ ] Fixtures generables.
- [ ] Suite de conformidad de 26 perfiles.
- [ ] Suite por fuentes.
- [ ] Reporte legible por CI con ffprobe.
- [ ] Release del core consumible por Android.

