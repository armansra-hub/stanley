import { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("node:https", () => ({ request: mock.request }));
import { fetchPublicHttpBytes, fetchPublicHttpText } from "./urlSafety";
let payload: Buffer, status: number, location: string | undefined;
const resolver = async () => [{address:"93.184.216.34",family:4 as const}];
beforeEach(() => {
  payload = Buffer.from([0x25,0x50,0x44,0x46,0x00,0xff]); status=200; location=undefined; mock.request.mockReset();
  mock.request.mockImplementation((_url, options, onResponse) => {
    const request = new EventEmitter() as EventEmitter & {end:()=>void;destroy:(error?:Error)=>void};
    request.destroy = error => { if(error) request.emit("error",error); };
    request.end = () => queueMicrotask(() => {
      options.lookup("company.com",{},(error:unknown,address:string) => { expect(error).toBeNull(); expect(address).toBe("93.184.216.34"); });
      const response = new EventEmitter() as EventEmitter & {headers:unknown;statusCode:number;destroy:(error?:Error)=>void};
      response.headers={"content-type":"application/pdf",location}; response.statusCode=status;
      let destroyed=false; response.destroy=error=>{destroyed=true;if(error) response.emit("error",error);};
      onResponse(response);
      if(!destroyed) { response.emit("data",payload); if(!destroyed) response.emit("end"); }
    });
    return request;
  });
});
describe("pinned binary public fetch",()=>{
  it("preserves arbitrary bytes while keeping text decoding compatible",async()=>{
    expect((await fetchPublicHttpBytes("https://company.com/a.pdf",{resolver})).body).toEqual(new Uint8Array(payload));
    payload=Buffer.from("Public café evidence");
    expect((await fetchPublicHttpText("https://company.com/about",{resolver})).body).toBe("Public café evidence");
  });
  it("rejects a redirect into a private target before another request",async()=>{
    status=302;location="http://169.254.169.254/metadata";
    await expect(fetchPublicHttpBytes("https://company.com/a.pdf",{resolver})).rejects.toThrow();
    expect(mock.request).toHaveBeenCalledOnce();
  });
  it("stops a body exceeding its byte cap",async()=>{
    payload=Buffer.alloc(20_000);
    await expect(fetchPublicHttpBytes("https://company.com/a.pdf",{resolver,maxBytes:16_384})).rejects.toThrow("size limit");
  });
});
