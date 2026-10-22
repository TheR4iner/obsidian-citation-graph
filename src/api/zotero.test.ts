import { describe, expect, it } from "vitest";
import { localPdfFileUrl, pdfAttachmentPath } from "./zotero";

// Shape of a Zotero 7 local API item search result (toResponseJSONAsync).
const item = (over: { doi?: string; extra?: string; itemType?: string; link?: Record<string, unknown> | null }) => ({
  key: "PARENT01",
  data: { key: "PARENT01", itemType: over.itemType ?? "journalArticle", DOI: over.doi, extra: over.extra },
  links: {
    self: { href: "http://localhost:23119/api/users/0/items/PARENT01" },
    ...(over.link === null
      ? {}
      : {
          attachment: {
            href: "http://localhost:23119/api/users/0/items/ATTACH01",
            type: "application/json",
            attachmentType: "application/pdf",
            attachmentSize: 123456,
            ...over.link,
          },
        }),
  },
});

describe("pdfAttachmentPath", () => {
  it("returns the attachment's API path for an exact DOI match", () => {
    expect(pdfAttachmentPath([item({ doi: "10.1000/ABC" })], "10.1000/abc")).toBe("/api/users/0/items/ATTACH01");
  });

  it("matches a DOI held in the Extra field", () => {
    expect(pdfAttachmentPath([item({ extra: "DOI: 10.1000/abc" })], "10.1000/abc")).toBe("/api/users/0/items/ATTACH01");
  });

  it("skips items whose DOI only contains the searched one", () => {
    expect(pdfAttachmentPath([item({ doi: "10.1000/abc.2" })], "10.1000/abc")).toBeNull();
  });

  it("skips an item with no attachment", () => {
    expect(pdfAttachmentPath([item({ doi: "10.1000/abc", link: null })], "10.1000/abc")).toBeNull();
  });

  it("skips a best attachment that is not a PDF", () => {
    expect(pdfAttachmentPath([item({ doi: "10.1000/abc", link: { attachmentType: "text/html" } })], "10.1000/abc")).toBeNull();
  });

  it("skips a PDF whose file is not on disk", () => {
    expect(pdfAttachmentPath([item({ doi: "10.1000/abc", link: { attachmentSize: undefined } })], "10.1000/abc")).toBeNull();
  });

  it("keeps group library paths", () => {
    const found = item({ doi: "10.1000/abc", link: { href: "http://localhost:23119/api/groups/42/items/ATTACH02" } });
    expect(pdfAttachmentPath([found], "10.1000/abc")).toBe("/api/groups/42/items/ATTACH02");
  });

  it("refuses an href that is not an item path", () => {
    const odd = item({ doi: "10.1000/abc", link: { href: "http://localhost:23119/api/users/0/items/A/../../x" } });
    expect(pdfAttachmentPath([odd], "10.1000/abc")).toBeNull();
  });

  it("ignores attachments and notes in the results, and junk input", () => {
    expect(pdfAttachmentPath([item({ doi: "10.1000/abc", itemType: "attachment" })], "10.1000/abc")).toBeNull();
    expect(pdfAttachmentPath({ not: "an array" }, "10.1000/abc")).toBeNull();
  });
});

describe("localPdfFileUrl", () => {
  it("accepts a local PDF file URL", () => {
    expect(localPdfFileUrl("file:///home/u/Zotero/storage/AB12/A%20B.PDF\n")).toBe("file:///home/u/Zotero/storage/AB12/A%20B.PDF");
    expect(localPdfFileUrl("file:///C:/Users/u/Zotero/a.pdf")).toBe("file:///C:/Users/u/Zotero/a.pdf");
  });

  it("refuses a network share, a non-PDF, another scheme, and junk", () => {
    expect(localPdfFileUrl("file://server/share/a.pdf")).toBeNull();
    expect(localPdfFileUrl("file:///home/u/run.sh")).toBeNull();
    expect(localPdfFileUrl("https://example.org/a.pdf")).toBeNull();
    expect(localPdfFileUrl("false")).toBeNull();
  });
});

