import { describe, expect, it, vi } from "vitest";
import { googleArticleId, legacyGoogleArticleUrl, googleDecodingParameters, parseGoogleDecodedUrl, resolveGoogleArticle } from "./googleNewsDecoder";
const envelope = (url: string) => `)]}'\n\n${JSON.stringify([["wrb.fr", "Fbv4je", JSON.stringify(["garturlres", url, 1]), null]])}\n`;
describe("Google public article-link decoding", () => {
  it("decodes legacy protobuf URLs including multibyte lengths without a network call", async () => {
    const url = `https://publisher.com/article/${"a".repeat(140)}`;
    const data = Buffer.from(url); const length = [data.length % 128 + 128, Math.floor(data.length / 128)];
    const id = Buffer.concat([Buffer.from([8, 19, 34, ...length]), data, Buffer.from([210, 1, 0])]).toString("base64url");
    expect(legacyGoogleArticleUrl(id)).toBe(url);
    const post = vi.fn();
    expect(await resolveGoogleArticle(`https://news.google.com/rss/articles/${id}`, "", { post })).toMatchObject({ url, method: "base64_protobuf" });
    expect(post).not.toHaveBeenCalled();
  });
  it("uses public signature parameters and only the expected RPC result, then caches it", async () => {
    const source = "https://news.google.com/rss/articles/CBMimodernTEST1";
    const html = '<div data-n-a-ts="1725891265" data-n-a-sg="public_signature_test"></div>';
    expect(googleDecodingParameters(html)).toEqual({ timestamp: 1725891265, signature: "public_signature_test" });
    const post = vi.fn(async body => {
      const request = JSON.parse(new URLSearchParams(body).get("f.req")!);
      expect(request[0][0][0]).toBe("Fbv4je");
      expect(JSON.parse(request[0][0][1]).slice(2)).toEqual(["CBMimodernTEST1", 1725891265, "public_signature_test"]);
      return envelope("https://publisher.com/news/real-article");
    });
    expect(await resolveGoogleArticle(source, html, { post })).toMatchObject({ method: "public_google_rpc", url: "https://publisher.com/news/real-article" });
    expect(await resolveGoogleArticle(source, html, { post })).toMatchObject({ method: "cache" });
    expect(post).toHaveBeenCalledOnce();
  });
  it("rejects forged/unsafe or unexpected result URLs and unrelated hosts", () => {
    expect(googleArticleId("https://news.google.com.evil.com/rss/articles/CBMiexample")).toBeNull();
    expect(parseGoogleDecodedUrl(envelope("http://127.0.0.1/internal"))).toBeNull();
    expect(parseGoogleDecodedUrl(envelope("https://news.google.com/articles/loop"))).toBeNull();
    expect(parseGoogleDecodedUrl(JSON.stringify([["wrong", "Fbv4je", JSON.stringify(["garturlres", "https://publisher.com/story"])]]))).toBeNull();
  });
});
