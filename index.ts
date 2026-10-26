import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const OCR_DIR = "/tmp/ocr";
const PORT = Number(process.env.PORT) || 3000;

interface OcrRequestPayload {
  base64Image?: string;
}

interface ParsedPageResult {
  ParsedText: string;
}

interface OcrSuccessResponse {
  IsErroredOnProcessing: false;
  ParsedResults: ParsedPageResult[];
}

interface OcrErrorResponse {
  IsErroredOnProcessing: true;
  ErrorMessage: string[];
}

/**
 * Elimina todos los archivos temporales asociados al UUID del proceso actual (PDF e imágenes JPG).
 */
async function cleanupJobFiles(jobId: string): Promise<void> {
  try {
    const files = await readdir(OCR_DIR);
    const targets = files.filter(
      (file) => file === `${jobId}.pdf` || file.startsWith(`${jobId}-`)
    );
    await Promise.all(
      targets.map((file) => unlink(join(OCR_DIR, file)).catch(() => {}))
    );
  } catch {
    // Ignorar si el directorio aún no existe o ya fue limpiado
  }
}

const server = Bun.serve({
  port: PORT,
  maxRequestBodySize: 50 * 1024 * 1024, // 50 MB para soportar PDFs multipágina en base64
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    // Endpoint de verificación de salud opcional
    if (req.method === "GET" && url.pathname === "/health") {
      return Response.json({ status: "ok" }, { status: 200 });
    }

    if (req.method !== "POST" || url.pathname !== "/") {
      const errorResponse: OcrErrorResponse = {
        IsErroredOnProcessing: true,
        ErrorMessage: [`Ruta o método no permitido: ${req.method} ${url.pathname}. Use POST /`],
      };
      return Response.json(errorResponse, { status: 500 });
    }

    const jobId = crypto.randomUUID();
    const pdfPath = join(OCR_DIR, `${jobId}.pdf`);
    const outputPrefix = join(OCR_DIR, jobId);

    try {
      // 1. Asegurar que exista el directorio temporal /tmp/ocr/
      await mkdir(OCR_DIR, { recursive: true });

      // 2. Leer y validar el JSON de entrada
      let body: OcrRequestPayload;
      try {
        body = (await req.json()) as OcrRequestPayload;
      } catch {
        throw new Error("El cuerpo de la petición no es un JSON válido.");
      }

      if (!body || typeof body.base64Image !== "string" || !body.base64Image.trim()) {
        throw new Error(
          'El campo "base64Image" es obligatorio y debe contener un string en formato base64.'
        );
      }

      // 3. Extraer el string base64 puro (removiendo el prefijo data:application/pdf;base64, si existe)
      const pureBase64 = body.base64Image
        .replace(/^data:[^;]+;base64,/i, "")
        .replace(/\s+/g, "");

      if (!pureBase64) {
        throw new Error("El contenido base64 extraído está vacío.");
      }

      const pdfBuffer = Buffer.from(pureBase64, "base64");
      if (pdfBuffer.byteLength === 0) {
        throw new Error("No se pudo decodificar el archivo PDF desde base64.");
      }

      // Validar cabecera mágica %PDF-
      const pdfHeader = pdfBuffer.subarray(0, 5).toString("ascii");
      if (pdfHeader !== "%PDF-") {
        throw new Error("El archivo decodificado no corresponde a un documento PDF válido.");
      }

      // Guardar el PDF temporal en /tmp/ocr/<uuid>.pdf
      await Bun.write(pdfPath, pdfBuffer);

      // 4. Convertir todas las páginas del PDF a imágenes JPG a 300 DPI usando pdftoppm
      const pdftoppmProc = Bun.spawn(
        ["pdftoppm", "-jpeg", "-r", "300", pdfPath, outputPrefix],
        {
          stdout: "pipe",
          stderr: "pipe",
        }
      );

      const [pdftoppmStderr, pdftoppmExitCode] = await Promise.all([
        new Response(pdftoppmProc.stderr).text(),
        pdftoppmProc.exited,
      ]);

      if (pdftoppmExitCode !== 0) {
        throw new Error(
          `Fallo al convertir PDF a JPG con pdftoppm (código ${pdftoppmExitCode}): ${pdftoppmStderr.trim()}`
        );
      }

      // 5. Escanear /tmp/ocr/ para listar y ordenar las imágenes JPG generadas en este ciclo
      const allFiles = await readdir(OCR_DIR);
      const generatedImages = allFiles
        .filter(
          (file) =>
            file.startsWith(`${jobId}-`) &&
            (file.endsWith(".jpg") || file.endsWith(".jpeg"))
        )
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));

      if (generatedImages.length === 0) {
        throw new Error("pdftoppm no generó ninguna imagen a partir del PDF suministrado.");
      }

      // 6. Ejecutar Tesseract OCR sobre cada página generada
      const parsedResults: ParsedPageResult[] = [];

      for (const imageFile of generatedImages) {
        const imagePath = join(OCR_DIR, imageFile);

        const tesseractProc = Bun.spawn(
          ["tesseract", imagePath, "stdout", "-l", "spa"],
          {
            stdout: "pipe",
            stderr: "pipe",
          }
        );

        const [stdoutText, stderrText, tesseractExitCode] = await Promise.all([
          new Response(tesseractProc.stdout).text(),
          new Response(tesseractProc.stderr).text(),
          tesseractProc.exited,
        ]);

        if (tesseractExitCode !== 0) {
          throw new Error(
            `Fallo en Tesseract OCR procesando ${imageFile} (código ${tesseractExitCode}): ${stderrText.trim()}`
          );
        }

        parsedResults.push({
          ParsedText: stdoutText.trim(),
        });
      }

      // 7. Devolver respuesta estructurada exitosa
      const responsePayload: OcrSuccessResponse = {
        IsErroredOnProcessing: false,
        ParsedResults: parsedResults,
      };

      return Response.json(responsePayload, { status: 200 });
    } catch (error) {
      const detail =
        error instanceof Error ? error.message : "Error desconocido durante el procesamiento OCR.";

      const errorPayload: OcrErrorResponse = {
        IsErroredOnProcessing: true,
        ErrorMessage: [detail],
      };

      return Response.json(errorPayload, { status: 500 });
    } finally {
      // 8. Eliminar todos los archivos temporales (PDF e imágenes JPG) de este ciclo
      await cleanupJobFiles(jobId);
    }
  },
});

console.log(`🚀 Microservicio OCR escuchando en http://0.0.0.0:${server.port}`);
