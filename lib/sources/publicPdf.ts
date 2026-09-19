import "server-only";
import { fetchPublicHttpBytes } from "@/lib/triggers/urlSafety";

export type PublicPdfEvidence = {
  status: "extracted" | "no_readable_text";
  url: string; text: string; pagesRead: number; totalPages: number; bytes: number;
  truncated: boolean; truncationReasons: ("page_limit" | "text_limit" | "deadline")[];
  evidenceKind: "public_pdf_text";
};
export type PublicPdfOptions = {
  mode: "deep"; deadlineMs: number; maxBytes?: number; maxPages?: number; maxTextChars?: number;
};
const bounded = (value: number | undefined, fallback: number, max: number) => Math.max(1, Math.min(Number.isFinite(value) ? Math.floor(value!) : fallback, max));
async function beforeDeadline<T>(promise: Promise<T>, deadline: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("PDF extraction deadline exceeded")), Math.max(0, deadline - Date.now()));
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Deep research only. Text extraction does not run scripts, fetch links, render
 * pages or perform OCR. Deadlines cancel asynchronous PDF work; as with other
 * in-process parsers, synchronous parser work cannot be preempted by a timer. */
export async function extractPublicPdfText(bytes: Uint8Array, url: string, options: PublicPdfOptions): Promise<PublicPdfEvidence> {
  if (options.mode !== "deep") throw new Error("Public PDFs require deep research mode");
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs - Date.now() < 250) throw new Error("Insufficient PDF extraction time");
  if (bytes.byteLength > bounded(options.maxBytes, 3_000_000, 5_000_000)) throw new Error("PDF exceeds byte limit");
  if (!Buffer.from(bytes.subarray(0, 1024)).includes(Buffer.from("%PDF-"))) throw new Error("Source is not a PDF");
  const maxPages = bounded(options.maxPages, 12, 20), maxText = bounded(options.maxTextChars, 20_000, 40_000);
  const { getResolvedPDFJS } = await beforeDeadline(import("unpdf"), options.deadlineMs);
  const pdfjs = await beforeDeadline(getResolvedPDFJS(), options.deadlineMs);
  const loading = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, disableFontFace: true,
    useSystemFonts: true, useWorkerFetch: false, disableAutoFetch: true, disableStream: true,
    disableRange: true, maxImageSize: 0, stopAtErrors: true, verbosity: 0 });
  let pagesRead = 0, text = "";
  const truncationReasons: PublicPdfEvidence["truncationReasons"] = [];
  try {
    const pdf = await beforeDeadline(loading.promise, options.deadlineMs);
    if (pdf.numPages > maxPages) truncationReasons.push("page_limit");
    for (let pageNo = 1; pageNo <= Math.min(pdf.numPages, maxPages); pageNo++) {
      if (Date.now() + 100 >= options.deadlineMs) { truncationReasons.push("deadline"); break; }
      try {
        const page = await beforeDeadline(pdf.getPage(pageNo), options.deadlineMs);
        try {
          const content = await beforeDeadline(page.getTextContent(), options.deadlineMs);
          const pageText = content.items.flatMap(item => "str" in item ? [item.str + (item.hasEOL ? "\n" : " ")] : []).join("").trim();
          pagesRead++;
          const addition = pageText ? `${text ? "\n\n" : ""}[PDF page ${pageNo}]\n${pageText}` : "";
          const remaining = maxText - text.length;
          text += addition.slice(0, remaining);
          if (addition.length > remaining || text.length >= maxText) { truncationReasons.push("text_limit"); break; }
        } finally { page.cleanup(); }
      } catch (error) {
        if (Date.now() >= options.deadlineMs) { truncationReasons.push("deadline"); break; }
        throw error;
      }
    }
    return { status: text.trim() ? "extracted" : "no_readable_text", url, text, pagesRead, totalPages: pdf.numPages,
      bytes: bytes.byteLength, truncated: truncationReasons.length > 0, truncationReasons, evidenceKind: "public_pdf_text" };
  } finally { await loading.destroy(); }
}

export async function fetchPublicPdfEvidence(url: string, options: PublicPdfOptions): Promise<PublicPdfEvidence> {
  if (options.mode !== "deep") throw new Error("Public PDFs require deep research mode");
  if (!Number.isFinite(options.deadlineMs) || options.deadlineMs - Date.now() < 1500) throw new Error("Insufficient PDF fetch time");
  const response = await fetchPublicHttpBytes(url, { timeoutMs: Math.min(10_000, options.deadlineMs - Date.now() - 500),
    maxBytes: bounded(options.maxBytes, 3_000_000, 5_000_000), accept: "application/pdf" });
  if (response.status < 200 || response.status >= 300) throw new Error(`PDF HTTP status ${response.status}`);
  return extractPublicPdfText(response.body, response.finalUrl, options);
}
