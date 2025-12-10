#!/usr/bin/env node
/**
 * Generates icon.ico for Windows from icon.png
 * Run: node scripts/generate-ico.js
 */
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const sizes = [16, 32, 48, 64, 128, 256];
const inputPath = path.join(__dirname, '..', 'icon.png');
const outputPath = path.join(__dirname, '..', 'icon.ico');

async function generateIco() {
  // ICO file format header
  const images = [];
  
  for (const size of sizes) {
    const buffer = await sharp(inputPath)
      .resize(size, size)
      .png()
      .toBuffer();
    images.push({ size, buffer });
  }

  // Build ICO file
  // ICO Header: 6 bytes
  // ICO Directory Entry: 16 bytes each
  // Image data follows
  
  const headerSize = 6;
  const dirEntrySize = 16;
  const dirSize = dirEntrySize * images.length;
  
  let dataOffset = headerSize + dirSize;
  const entries = [];
  
  for (const img of images) {
    entries.push({
      width: img.size === 256 ? 0 : img.size,
      height: img.size === 256 ? 0 : img.size,
      colors: 0,
      reserved: 0,
      planes: 1,
      bpp: 32,
      size: img.buffer.length,
      offset: dataOffset,
      buffer: img.buffer,
    });
    dataOffset += img.buffer.length;
  }
  
  // Calculate total size
  const totalSize = headerSize + dirSize + images.reduce((sum, img) => sum + img.buffer.length, 0);
  const ico = Buffer.alloc(totalSize);
  
  // Write header
  ico.writeUInt16LE(0, 0);      // Reserved
  ico.writeUInt16LE(1, 2);      // Type: 1 = ICO
  ico.writeUInt16LE(images.length, 4); // Image count
  
  // Write directory entries
  let pos = 6;
  for (const entry of entries) {
    ico.writeUInt8(entry.width, pos);
    ico.writeUInt8(entry.height, pos + 1);
    ico.writeUInt8(entry.colors, pos + 2);
    ico.writeUInt8(entry.reserved, pos + 3);
    ico.writeUInt16LE(entry.planes, pos + 4);
    ico.writeUInt16LE(entry.bpp, pos + 6);
    ico.writeUInt32LE(entry.size, pos + 8);
    ico.writeUInt32LE(entry.offset, pos + 12);
    pos += 16;
  }
  
  // Write image data
  for (const entry of entries) {
    entry.buffer.copy(ico, entry.offset);
  }
  
  fs.writeFileSync(outputPath, ico);
  console.log(`Created ${outputPath} with ${images.length} sizes: ${sizes.join(', ')}px`);
}

generateIco().catch(console.error);
