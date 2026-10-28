// Ficheros del paquete (panel, instrucciones, package.json) incrustados en el ejecutable sin Node. Con npm o una copia de
// git es null y se leen del disco. scripts/build-binaries.mjs lo sustituye, solo en su copia de compilación, por el
// contenido real (ruta relativa al paquete → base64).
export const EMBEDDED: Record<string, string> | null = null;
