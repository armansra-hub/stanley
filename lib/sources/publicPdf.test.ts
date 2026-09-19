import { describe, expect, it, vi } from "vitest";
vi.mock("@/lib/triggers/urlSafety", async original => ({ ...await original<typeof import("@/lib/triggers/urlSafety")>(), fetchPublicHttpBytes: vi.fn() }));
import { fetchPublicHttpBytes } from "@/lib/triggers/urlSafety";
import { extractPublicPdfText, fetchPublicPdfEvidence } from "./publicPdf";

// A real two-page PDF with byte-correct xref offsets. No parser/mock substitute.
function pdf(pages: string[]) {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${pages.map((_, i) => `${4+i*2} 0 R`).join(" ")}] /Count ${pages.length} >>`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  pages.forEach((text, i) => {
    const stream = `BT /F1 12 Tf 50 750 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5+i*2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  let result = "%PDF-1.7\n"; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(result.length); result += `${i+1} 0 obj\n${object}\nendobj\n`; });
  const xref = result.length;
  result += `xref\n0 ${objects.length+1}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10,"0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(result));
}
const options = () => ({ mode: "deep" as const, deadlineMs: Date.now()+10_000 });
describe("bounded public PDF evidence", () => {
  it("extracts actual PDF text with page provenance and reports unread pages", async () => {
    const result = await extractPublicPdfText(pdf(["Capabilities and contracts", "Second page facts"]), "https://company.com/capabilities.pdf", {...options(),maxPages:1});
    expect(result).toMatchObject({status:"extracted",pagesRead:1,totalPages:2,truncated:true,truncationReasons:["page_limit"]});
    expect(result.text).toContain("[PDF page 1]\nCapabilities and contracts");
    expect(result.text).not.toContain("Second page");
  });
  it("enforces text limit and does not claim an empty/scanned page is readable", async () => {
    const result = await extractPublicPdfText(pdf(["A long explicit capability statement"]), "https://company.com/a.pdf", {...options(),maxTextChars:20});
    expect(result.text).toHaveLength(20); expect(result.truncationReasons).toContain("text_limit");
    const empty = await extractPublicPdfText(pdf([""]), "https://company.com/a.pdf", options());
    expect(empty).toMatchObject({status:"no_readable_text",text:"",pagesRead:1,totalPages:1});
  });
  it("rejects non-PDF, oversized and expired work before parsing", async () => {
    await expect(extractPublicPdfText(new Uint8Array(Buffer.from("<html>not pdf</html>")), "https://company.com/a.pdf", options())).rejects.toThrow("not a PDF");
    await expect(extractPublicPdfText(pdf(["hello"]), "https://company.com/a.pdf", {...options(),maxBytes:10})).rejects.toThrow("byte limit");
    await expect(extractPublicPdfText(pdf(["hello"]), "https://company.com/a.pdf", {...options(),deadlineMs:Date.now()})).rejects.toThrow("Insufficient");
  });
  it("uses bounded safe binary fetch and retains its final source URL", async () => {
    vi.mocked(fetchPublicHttpBytes).mockResolvedValue({status:200,finalUrl:"https://company.com/final.pdf",contentType:"application/pdf",body:pdf(["Actual source"])});
    const result = await fetchPublicPdfEvidence("https://company.com/download",options());
    expect(result.url).toBe("https://company.com/final.pdf");
    expect(fetchPublicHttpBytes).toHaveBeenCalledWith("https://company.com/download",expect.objectContaining({maxBytes:3_000_000,accept:"application/pdf"}));
  });
});
