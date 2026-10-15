/** Controlled pixel probes: check actual visual understanding rather than HTTP acceptance. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

const env = readFileSync(resolve(import.meta.dir, "../../../apps/api/.env"), "utf8");
const key = env
  .split(/\r?\n/)
  .find((line) => line.startsWith("ALEM_API_KEY="))
  ?.slice(13)
  .trim();
if (!key) throw new Error("Missing ALEM_API_KEY");
function crc(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Buffer): Buffer {
  const tag = Buffer.from(name),
    size = Buffer.alloc(4),
    checksum = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  checksum.writeUInt32BE(crc(Buffer.concat([tag, data])));
  return Buffer.concat([size, tag, data, checksum]);
}
function png(pixel: (x: number, y: number) => readonly number[]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(128, 0);
  header.writeUInt32BE(128, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = Buffer.alloc(128 * 385);
  for (let y = 0; y < 128; y++)
    for (let x = 0; x < 128; x++) {
      const color = pixel(x, y),
        index = y * 385 + 1 + x * 3;
      pixels[index] = color[0] ?? 255;
      pixels[index + 1] = color[1] ?? 255;
      pixels[index + 2] = color[2] ?? 255;
    }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const white = [255, 255, 255];
const probes = [
  {
    expected: /red/i,
    image: png((x, y) => (x >= 32 && x < 96 && y >= 32 && y < 96 ? [255, 0, 0] : white)),
  },
  {
    expected: /blue/i,
    image: png((x, y) => (x >= 48 && x < 80 && y >= 16 && y < 112 ? [0, 0, 255] : white)),
  },
];
for (const [index, probe] of probes.entries()) {
  const response = await fetch("https://llm.alem.ai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model: "qwen3-8",
      max_tokens: 180,
      chat_template_kwargs: { enable_thinking: false },
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Describe the visible shape, its color and background. Use only what you see.",
            },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${probe.image.toString("base64")}` },
            },
          ],
        },
      ],
    }),
  });
  const body = (await response.json()) as { choices?: Array<{ message: { content?: string } }> };
  const description = body.choices?.[0]?.message.content ?? "";
  if (!response.ok || !probe.expected.test(description))
    throw new Error(`Vision probe ${index + 1} failed (${response.status}): ${description}`);
  console.log(JSON.stringify({ probe: index + 1, status: response.status, description }));
}
const chair = png((x, y) => {
  if (x >= 30 && x < 98 && y >= 20 && y < 58) return [30, 150, 60];
  if (x >= 22 && x < 106 && y >= 58 && y < 72) return [220, 30, 30];
  if (((x >= 30 && x < 42) || (x >= 86 && x < 98)) && y >= 72 && y < 118) return [30, 60, 220];
  return white;
});
const directory = resolve(import.meta.dir, "../../../.nap-objects/demo-quality");
mkdirSync(directory, { recursive: true });
writeFileSync(resolve(directory, "vision-reference.png"), chair);
console.log("Vision verified; synthetic chair reference saved for the scene-generation rehearsal.");
