import { describe, expect, it } from "vitest";
import { mergeResponseHeaders, resolveCorsHeaders } from "../src/cors";

describe("resolveCorsHeaders", () => {
  it("returns empty object for false", () => {
    expect(resolveCorsHeaders(false, "http://a.example")).toEqual({});
  });

  it("returns empty object for null", () => {
    expect(resolveCorsHeaders(null, "http://a.example")).toEqual({});
  });

  it("returns empty object for undefined", () => {
    expect(resolveCorsHeaders(undefined, "http://a.example")).toEqual({});
  });

  it("returns wildcard for true", () => {
    expect(resolveCorsHeaders(true, "http://a.example")).toEqual({
      "Access-Control-Allow-Origin": "*",
    });
  });

  it("returns wildcard for { origin: '*' }", () => {
    expect(resolveCorsHeaders({ origin: "*" }, "http://a.example")).toEqual({
      "Access-Control-Allow-Origin": "*",
    });
  });

  it("matches consistently across repeated calls for a global-flag regex", () => {
    // Regression: `g`/`y` regexes are stateful (`test()` advances lastIndex),
    // which used to make consecutive requests alternate match/no-match.
    const cors = { origin: /example$/g };
    for (let i = 0; i < 4; i++) {
      expect(resolveCorsHeaders(cors, "http://a.example")).toEqual({
        "Access-Control-Allow-Origin": "http://a.example",
        "Vary": "Origin",
      });
    }
  });

  it("leaves a caller's sticky regex usable and matches consistently", () => {
    const origin = /^http:\/\/a\.example$/y;
    const cors = { origin };
    for (let i = 0; i < 3; i++) {
      expect(resolveCorsHeaders(cors, "http://a.example")).toEqual({
        "Access-Control-Allow-Origin": "http://a.example",
        "Vary": "Origin",
      });
    }
    expect(origin.lastIndex).toBe(0);
  });

  it("returns wildcard for {} (origin defaults to '*')", () => {
    expect(resolveCorsHeaders({}, "http://a.example")).toEqual({
      "Access-Control-Allow-Origin": "*",
    });
  });

  it("reflects origin with Vary when origin is true and requestOrigin is present", () => {
    expect(resolveCorsHeaders({ origin: true }, "http://a.example")).toEqual({
      "Access-Control-Allow-Origin": "http://a.example",
      "Vary": "Origin",
    });
  });

  it("returns empty when origin is true and requestOrigin is undefined", () => {
    expect(resolveCorsHeaders({ origin: true }, undefined)).toEqual({});
  });

  it("matches exact string origin", () => {
    expect(resolveCorsHeaders({ origin: "http://a.example" }, "http://a.example")).toEqual({
      "Access-Control-Allow-Origin": "http://a.example",
      "Vary": "Origin",
    });
  });

  it("returns empty for mismatched string origin", () => {
    expect(resolveCorsHeaders({ origin: "http://a.example" }, "http://b.example")).toEqual({});
  });

  it("matches RegExp origin", () => {
    expect(resolveCorsHeaders({ origin: /\.example$/ }, "http://a.example")).toEqual({
      "Access-Control-Allow-Origin": "http://a.example",
      "Vary": "Origin",
    });
  });

  it("returns empty for RegExp that does not match", () => {
    expect(resolveCorsHeaders({ origin: /\.example$/ }, "http://a.com")).toEqual({});
  });

  it("matches any element in an array origin", () => {
    const origin = ["http://a.example", /\.b\.example$/];
    expect(resolveCorsHeaders({ origin }, "http://a.example")).toEqual({
      "Access-Control-Allow-Origin": "http://a.example",
      "Vary": "Origin",
    });
    expect(resolveCorsHeaders({ origin }, "http://x.b.example")).toEqual({
      "Access-Control-Allow-Origin": "http://x.b.example",
      "Vary": "Origin",
    });
  });

  it("returns empty when no element in array matches", () => {
    expect(resolveCorsHeaders({ origin: ["http://a.example"] }, "http://b.example")).toEqual({});
  });

  it("adds credentials header when credentials is true with wildcard", () => {
    expect(resolveCorsHeaders({ origin: "*", credentials: true }, "http://a.example")).toEqual({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Credentials": "true",
    });
  });

  it("adds credentials header with reflected origin", () => {
    expect(resolveCorsHeaders({ origin: true, credentials: true }, "http://a.example")).toEqual({
      "Access-Control-Allow-Origin": "http://a.example",
      "Vary": "Origin",
      "Access-Control-Allow-Credentials": "true",
    });
  });

  it("adds credentials header with string origin", () => {
    expect(resolveCorsHeaders({ origin: "http://a.example", credentials: true }, "http://a.example")).toEqual({
      "Access-Control-Allow-Origin": "http://a.example",
      "Vary": "Origin",
      "Access-Control-Allow-Credentials": "true",
    });
  });

  it("returns empty for function origin (unsupported)", () => {
    expect(resolveCorsHeaders({ origin: () => true }, "http://a.example")).toEqual({});
  });

  it("returns empty for { origin: false }", () => {
    expect(resolveCorsHeaders({ origin: false }, "http://a.example")).toEqual({});
  });
});

describe("mergeResponseHeaders", () => {
  it("adds Origin to an existing Vary header", () => {
    expect(
      mergeResponseHeaders(
        { Vary: "Accept-Encoding" },
        { "Access-Control-Allow-Origin": "http://a.example", Vary: "Origin" },
      ),
    ).toEqual({
      "Access-Control-Allow-Origin": "http://a.example",
      Vary: "Accept-Encoding, Origin",
    });
  });

  it("recognizes Vary case-insensitively and avoids duplicate tokens", () => {
    expect(
      mergeResponseHeaders(
        { vary: ["Origin", "Accept-Encoding"] },
        { Vary: "origin" },
      ),
    ).toEqual({ vary: "Origin, Accept-Encoding" });
  });

  it("collapses all case-insensitive Vary keys before merging CORS", () => {
    expect(
      mergeResponseHeaders(
        {
          Vary: "Accept-Encoding",
          vary: ["User-Agent", "origin"],
          VARY: "Accept-Encoding",
        },
        { Vary: "Origin" },
      ),
    ).toEqual({
      Vary: "Accept-Encoding, User-Agent, origin",
    });
  });

  it("keeps Vary wildcard unchanged", () => {
    expect(
      mergeResponseHeaders({ Vary: "*" }, { Vary: "Origin" }),
    ).toEqual({ Vary: "*" });
  });
});
