import { describe, expect, it } from "vitest";
import { sitePageEvidence } from "./siteDiscovery";
import { visibleIdentityClaims } from "./companyIdentityEvidence";

describe("official identity declarations", () => {
  it("retains legal and related names with their own addresses, without flattening customer identity", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({ "@type": "Organization", name: "Acme", url: "https://acme.com",
      legalName: "Acme Services LLC", alternateName: "Acme Operations", parentOrganization: { name: "Owner Holdings", url: "https://owner.com", address: { streetAddress: "10 Owner Street", addressLocality: "Austin", addressRegion: "TX", postalCode: "78701" } },
      subOrganization: { name: "Acme West LLC", url: "https://west.com" }, customer: { name: "Customer LLC", address: { streetAddress: "99 Wrong Street" } } })}</script>`;
    const page = sitePageEvidence(html, "https://acme.com/about");
    expect(page.identityClaims?.map(row => [row.candidateName, row.relationshipHint])).toEqual([
      ["Acme Services LLC", "legal_name"], ["Acme Operations", "dba"], ["Owner Holdings", "parent"], ["Acme West LLC", "subsidiary"],
    ]);
    expect(page.identityClaims?.[2]).toMatchObject({ candidateDomain: "owner.com", candidateAddress: { addressLine1: "10 Owner Street" } });
    expect(page.companyIdentity?.addresses).toEqual([]);
  });
  it("does not borrow a foreign publisher or a second organization on a shared site", () => {
    const page = sitePageEvidence(`<script type="application/ld+json">{"@graph":[{"@type":"Organization","name":"Publisher","url":"https://publisher.com","legalName":"Wrong LLC"},{"@type":"Organization","name":"Acme","url":"https://acme.com","legalName":"Right LLC"},{"@type":"Organization","name":"Customer","url":"https://acme.com/customer","legalName":"Wrong Customer LLC"}]}</script>`, "https://acme.com");
    expect(page.identityClaims?.map(c => c.candidateName)).toEqual(["Right LLC"]);
  });
  it("extracts named visible legal, former, family and JV clauses from official page prose", () => {
    expect(visibleIdentityClaims("Acme is legally registered as Acme Services LLC. Acme, formerly known as Old Works LLC, serves Texas. Acme is a subsidiary of Owner Holdings. Acme formed a joint venture named Acme Venture LLC.", ["Acme"])
      .map(c => [c.candidateName, c.relationshipHint])).toEqual([["Old Works LLC", "former_name"], ["Acme Services LLC", "legal_name"], ["Owner Holdings", "parent"], ["Acme Venture LLC", "joint_venture"]]);
  });
  it("ignores anonymous we statements and customer/subsidiary prose not naming the account", () => {
    expect(visibleIdentityClaims("We are a subsidiary of Big Parent. Customer LLC acquired Other Company. Customer LLC is legally registered as Wrong LLC.", ["Acme"])).toEqual([]);
  });
});
