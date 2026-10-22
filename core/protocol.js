'use strict';
/**
 * Binary frame: server → browser
 *
 *  [0]     frame type   (0x01 = VNC)
 *  [1-36]  deviceId     UTF-8, null-padded to 36 bytes
 *  [37-40] payloadLen   uint32 BE
 *  [41-44] ts_hi        upper 32 bits of Date.now() ms timestamp
 *  [45-48] ts_lo        lower 32 bits
 *  [49+]   JPEG bytes
 *
 *  Total header: 49 bytes
 *  ts_hi/ts_lo lets browser compute end-to-end latency: Date.now() - ts
 */

const FRAME_VNC = 0x01;
const HDR_SIZE  = 49;  // 1 + 36 + 4 + 8
const ID_LEN    = 36;

/**
 * Build one VNC binary frame ready to send to operator browser.
 * Pre-encodes deviceId once per connection — pass the cached Buffer.
 *
 * @param {Buffer} devIdBuf  36-byte null-padded device-id Buffer (cached on ws)
 * @param {Buffer} jpeg      raw JPEG bytes
 * @returns {Buffer}
 */
function encodeVncFrame(devIdBuf, jpeg) {
  const buf = Buffer.allocUnsafe(HDR_SIZE + jpeg.length);

  buf[0] = FRAME_VNC;

  devIdBuf.copy(buf, 1);                         // bytes 1-36

  buf.writeUInt32BE(jpeg.length, 37);            // bytes 37-40

  const ts = Date.now();
  buf.writeUInt32BE(Math.floor(ts / 0x100000000) >>> 0, 41); // ts_hi
  buf.writeUInt32BE((ts >>> 0),                              45); // ts_lo

  jpeg.copy(buf, 49);                            // bytes 49+

  return buf;
}

module.exports = { encodeVncFrame, FRAME_VNC, HDR_SIZE };
