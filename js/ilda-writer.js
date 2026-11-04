/*
 * ilda-writer.js — writes laser frames as an ILDA (.ild) file.
 *
 * ILDA is the standard laser show file format, read by LaserOS and most laser
 * software. Spec: https://www.ilda.com/technical.htm ("ILDA Image Data Transfer Format").
 * We write format 5: 2D points with true (24-bit) colour.
 *
 * File layout: one 32-byte header + its points per frame, then a final header
 * with zero points that marks the end of the file. All numbers are big-endian.
 *
 *   Header (32 bytes)                       Point, format 5 (8 bytes)
 *   0-3   "ILDA"                            0-1  X  signed 16-bit, -32768 (left) .. 32767 (right)
 *   4-6   0, 0, 0 (reserved)                2-3  Y  signed 16-bit, -32768 (bottom) .. 32767 (top)
 *   7     format code (5)                   4    status: bit 7 (0x80) = last point of frame
 *   8-15  frame name (8 ASCII chars)                     bit 6 (0x40) = blanked (beam off)
 *   16-23 company name (8 ASCII chars)      5    blue  0..255
 *   24-25 number of points in this frame    6    green 0..255
 *   26-27 frame number (0-based)            7    red   0..255   (note: blue, green, red order)
 *   28-29 total number of frames
 *   30    projector number (0)
 *   31    reserved (0)
 */
'use strict';

const ILDA_FORMAT_2D_TRUE_COLOR = 5;
const ILDA_HEADER_BYTES = 32;
const ILDA_POINT_BYTES = 8;
const ILDA_COMPANY_NAME = 'LaserFS';     // shows up in other laser software as the file's creator

/**
 * frames: [{ name, laser: { points } }, ...]
 * holdCount: write each frame this many times in a row (slows playback).
 * Returns the file as a Uint8Array.
 */
function writeIldaFile(frames, holdCount) {
  const sequence = [];
  for (const frame of frames) for (let i = 0; i < holdCount; i++) sequence.push(frame);
  if (sequence.length > 65535) throw new Error('Too many frames for one ILDA file (max 65,535).');

  let fileSize = ILDA_HEADER_BYTES;        // the end-of-file header
  for (const frame of sequence) fileSize += ILDA_HEADER_BYTES + ILDA_POINT_BYTES * frame.laser.points.length;

  const buffer = new ArrayBuffer(fileSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  let offset = 0;

  function writeText8(at, text) {
    const clean = text.replace(/[^\x20-\x7e]/g, '');      // plain ASCII only
    for (let i = 0; i < 8; i++) bytes[at + i] = i < clean.length ? clean.charCodeAt(i) : 0;
  }
  function writeHeader(pointCount, frameNumber, frameName) {
    bytes.set([0x49, 0x4c, 0x44, 0x41], offset);           // "ILDA"
    bytes[offset + 7] = ILDA_FORMAT_2D_TRUE_COLOR;
    writeText8(offset + 8, frameName);
    writeText8(offset + 16, ILDA_COMPANY_NAME);
    view.setUint16(offset + 24, pointCount);
    view.setUint16(offset + 26, frameNumber);
    view.setUint16(offset + 28, sequence.length);
    offset += ILDA_HEADER_BYTES;
  }
  const toInt16 = v => Math.max(-32768, Math.min(32767, Math.round(v)));

  sequence.forEach((frame, frameNumber) => {
    const points = frame.laser.points;
    writeHeader(points.length, frameNumber, frame.name.replace(/\.[^.]+$/, ''));
    points.forEach((p, i) => {
      view.setInt16(offset, toInt16(p.x));
      view.setInt16(offset + 2, toInt16(p.y));
      const isLast = i === points.length - 1;
      bytes[offset + 4] = (isLast ? 0x80 : 0) | (p.blank ? 0x40 : 0);
      bytes[offset + 5] = p.b;
      bytes[offset + 6] = p.g;
      bytes[offset + 7] = p.r;
      offset += ILDA_POINT_BYTES;
    });
  });
  writeHeader(0, 0, '');                   // end of file
  return bytes;
}
