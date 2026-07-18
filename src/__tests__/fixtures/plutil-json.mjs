#!/usr/bin/env node

import { readFileSync } from "node:fs";

const args = process.argv.slice(2);
const inputPath = args[4];

try {
  if (
    args.length !== 5
    || args[0] !== "-convert"
    || args[1] !== "json"
    || args[2] !== "-o"
    || args[3] !== "-"
    || !inputPath
  ) {
    throw new Error("unsupported arguments");
  }

  const xml = readFileSync(inputPath === "-" ? 0 : inputPath, "utf8");
  process.stdout.write(`${JSON.stringify(parsePlist(xml))}\n`);
} catch {
  process.stderr.write(`fixture plist parser rejected private-parser-marker at ${inputPath ?? "unknown"}\n`);
  process.exitCode = 1;
}

function parsePlist(xml) {
  const tokens = xml.match(/<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<!--[\s\S]*?-->|<[^>]+>|[^<]+/g) ?? [];
  let position = 0;

  const skipTrivia = () => {
    while (
      position < tokens.length
      && (
        /^\s*$/.test(tokens[position])
        || tokens[position].startsWith("<?")
        || tokens[position].startsWith("<!DOCTYPE")
        || tokens[position].startsWith("<!--")
      )
    ) {
      position += 1;
    }
  };

  const readTextElement = (tag) => {
    if (tokens[position] === `<${tag}/>` || tokens[position] === `<${tag} />`) {
      position += 1;
      return "";
    }
    if (tokens[position] !== `<${tag}>`) {
      throw new Error(`expected ${tag}`);
    }
    position += 1;
    let text = "";
    while (position < tokens.length && tokens[position] !== `</${tag}>`) {
      if (tokens[position].startsWith("<")) {
        throw new Error(`unexpected element inside ${tag}`);
      }
      text += tokens[position];
      position += 1;
    }
    if (tokens[position] !== `</${tag}>`) {
      throw new Error(`unterminated ${tag}`);
    }
    position += 1;
    return decodeXml(text);
  };

  const parseValue = () => {
    skipTrivia();
    const token = tokens[position];
    if (token === "<dict>") {
      position += 1;
      const value = {};
      while (true) {
        skipTrivia();
        if (tokens[position] === "</dict>") {
          position += 1;
          return value;
        }
        const key = readTextElement("key");
        value[key] = parseValue();
      }
    }
    if (token === "<array>") {
      position += 1;
      const value = [];
      while (true) {
        skipTrivia();
        if (tokens[position] === "</array>") {
          position += 1;
          return value;
        }
        value.push(parseValue());
      }
    }
    if (/^<true\s*\/>$/.test(token)) {
      position += 1;
      return true;
    }
    if (/^<false\s*\/>$/.test(token)) {
      position += 1;
      return false;
    }
    if (token === "<string>" || /^<string\s*\/>$/.test(token)) {
      return readTextElement("string");
    }
    if (token === "<integer>") {
      const value = Number(readTextElement("integer"));
      if (!Number.isSafeInteger(value)) throw new Error("invalid integer");
      return value;
    }
    if (token === "<real>") {
      const value = Number(readTextElement("real"));
      if (!Number.isFinite(value)) throw new Error("invalid real");
      return value;
    }
    if (token === "<date>") return readTextElement("date");
    if (token === "<data>") return readTextElement("data").replace(/\s+/g, "");
    throw new Error(`unsupported plist token ${token ?? "EOF"}`);
  };

  skipTrivia();
  if (!/^<plist(?:\s[^>]*)?>$/.test(tokens[position])) {
    throw new Error("missing plist root");
  }
  position += 1;
  const value = parseValue();
  skipTrivia();
  if (tokens[position] !== "</plist>") throw new Error("unterminated plist root");
  position += 1;
  skipTrivia();
  if (position !== tokens.length) throw new Error("trailing plist content");
  return value;
}

function decodeXml(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_match, digits) => String.fromCodePoint(Number.parseInt(digits, 16)))
    .replace(/&#([0-9]+);/g, (_match, digits) => String.fromCodePoint(Number.parseInt(digits, 10)))
    .replaceAll("&apos;", "'")
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&");
}
