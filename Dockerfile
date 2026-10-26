# Imagen oficial de Bun basada en Debian (slim para optimizar tamaño manteniendo apt-get)
FROM oven/bun:1-slim

# Evitar prompts interactivos durante la instalación de paquetes con apt-get
ENV DEBIAN_FRONTEND=noninteractive

# Instalar dependencias nativas obligatorias:
# - poppler-utils (incluye pdftoppm)
# - tesseract-ocr (motor OCR nativo)
# - tesseract-ocr-spa (datos de idioma español)
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      poppler-utils \
      tesseract-ocr \
      tesseract-ocr-spa \
      ca-certificates && \
    apt-get clean && \
    rm -rf /var/lib/apt/lists/*

# Preparar directorio de trabajo y directorio temporal de OCR con permisos para el usuario bun
WORKDIR /app
RUN mkdir -p /tmp/ocr && chown -R bun:bun /tmp/ocr /app

# Copiar manifiesto de paquetes e instalar tipos/dependencias si existen
COPY --chown=bun:bun package.json ./
RUN bun install --production

# Copiar el código fuente del servidor
COPY --chown=bun:bun index.ts ./

# Ejecutar con el usuario sin privilegios incluido en la imagen oficial
USER bun

# Puerto por defecto del microservicio
ENV PORT=3000
EXPOSE 3000

# Iniciar el servidor nativo de Bun
CMD ["bun", "run", "index.ts"]
